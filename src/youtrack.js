// YouTrack API client
// Each user has their own API token stored in the database

const YOUTRACK_URL = process.env.YOUTRACK_URL;

export function getYouTrackClient(userToken) {
    if (!YOUTRACK_URL) {
        throw new Error('YOUTRACK_URL environment variable not configured');
    }
    if (!userToken) {
        throw new Error('YouTrack token not set. Use connect_youtrack to save your API token.');
    }

    const baseUrl = YOUTRACK_URL.replace(/\/$/, '');

    async function request(path, options = {}) {
        const url = `${baseUrl}/api${path}`;
        const response = await fetch(url, {
            ...options,
            headers: {
                'Authorization': `Bearer ${userToken}`,
                'Accept': 'application/json',
                'Content-Type': 'application/json',
                ...options.headers,
            },
        });

        if (!response.ok) {
            const text = await response.text();
            throw new Error(`YouTrack API error: ${response.status} ${text}`);
        }

        // Some endpoints return empty response
        const contentType = response.headers.get('content-type');
        if (contentType && contentType.includes('application/json')) {
            return response.json();
        }
        return null;
    }

    return {
        // Get issues with optional query
        async getIssues(query = '', project = null, assignee = 'me') {
            let q = query;
            if (!q && assignee === 'me') {
                q = 'for: me State: Unresolved';
            } else if (!q) {
                q = 'State: Unresolved';
            }
            if (project) {
                q = `project: ${project} ${q}`;
            }

            const params = new URLSearchParams({
                query: q,
                fields: 'id,idReadable,summary,description,resolved,created,updated,project(id,name,shortName)',
            });

            const issues = await request(`/issues?${params}`);
            return issues.map(issue => ({
                id: issue.idReadable,
                internalId: issue.id,
                summary: issue.summary,
                description: issue.description,
                resolved: issue.resolved,
                project: issue.project?.shortName || issue.project?.name,
                projectName: issue.project?.name,
                created: issue.created,
                updated: issue.updated,
            }));
        },

        // Get single issue details
        async getIssue(issueId) {
            const params = new URLSearchParams({
                fields: 'id,idReadable,summary,description,resolved,created,updated,project(id,name,shortName),customFields(name,value(name))',
            });

            const issue = await request(`/issues/${issueId}?${params}`);

            // Extract state from custom fields
            let state = 'Unknown';
            if (issue.customFields) {
                const stateField = issue.customFields.find(f => f.name === 'State');
                if (stateField && stateField.value) {
                    state = stateField.value.name;
                }
            }

            return {
                id: issue.idReadable,
                internalId: issue.id,
                summary: issue.summary,
                description: issue.description,
                state,
                resolved: issue.resolved,
                project: issue.project?.shortName || issue.project?.name,
                projectName: issue.project?.name,
                created: issue.created,
                updated: issue.updated,
            };
        },

        // Add comment to issue
        async addComment(issueId, text) {
            await request(`/issues/${issueId}/comments`, {
                method: 'POST',
                body: JSON.stringify({ text }),
            });
            return { success: true };
        },

        // Add work item (time log) to issue
        async addWorkItem(issueId, minutes, description = '', date = null) {
            const workDate = date ? new Date(date).getTime() : Date.now();

            await request(`/issues/${issueId}/timeTracking/workItems`, {
                method: 'POST',
                body: JSON.stringify({
                    duration: { minutes },
                    text: description,
                    date: workDate,
                }),
            });
            return { success: true, minutes };
        },

        // Update issue state (resolve/reopen)
        async updateIssueState(issueId, stateName) {
            // YouTrack uses commands to update state
            await request(`/issues/${issueId}`, {
                method: 'POST',
                body: JSON.stringify({
                    customFields: [
                        {
                            name: 'State',
                            $type: 'StateIssueCustomField',
                            value: { name: stateName },
                        },
                    ],
                }),
            });
            return { success: true, state: stateName };
        },

        // Resolve issue (convenience method)
        async resolveIssue(issueId) {
            return this.updateIssueState(issueId, 'Done');
        },
    };
}

// Map YouTrack state to local task status
export function mapYouTrackStateToStatus(state) {
    const resolvedStates = ['Done', 'Resolved', 'Fixed', 'Closed', 'Verified', 'Complete', 'Completed'];
    return resolvedStates.includes(state) ? 'done' : 'open';
}
