import { ChromaClient } from 'chromadb';
import { VoyageAIEmbeddingFunction } from '@chroma-core/voyageai';
import { loadData, saveData, formatDuration } from './storage.js';

// Initialize ChromaDB client
let chromaClient = null;
let memoriesCollection = null;
let entriesCollection = null;
let voyageEmbedder = null;

async function getChromaClient() {
    if (!chromaClient) {
        const chromaUrl = process.env.CHROMA_URL || 'http://localhost:8000';
        chromaClient = new ChromaClient({ path: chromaUrl });
    }
    return chromaClient;
}

async function getVoyageEmbedder() {
    if (!voyageEmbedder) {
        const apiKey = process.env.VOYAGE_API_KEY;
        if (!apiKey) {
            throw new Error('VOYAGE_API_KEY environment variable is required for memory features');
        }
        voyageEmbedder = new VoyageAIEmbeddingFunction({
            apiKey: apiKey,
            model: 'voyage-3-lite'
        });
    }
    return voyageEmbedder;
}

async function getMemoriesCollection() {
    if (!memoriesCollection) {
        const client = await getChromaClient();
        const embedder = await getVoyageEmbedder();
        memoriesCollection = await client.getOrCreateCollection({
            name: 'calq_memories',
            embeddingFunction: embedder
        });
    }
    return memoriesCollection;
}

async function getEntriesCollection() {
    if (!entriesCollection) {
        const client = await getChromaClient();
        const embedder = await getVoyageEmbedder();
        entriesCollection = await client.getOrCreateCollection({
            name: 'calq_entries',
            embeddingFunction: embedder
        });
    }
    return entriesCollection;
}

/**
 * Store a memory in ChromaDB
 * @param {string} content - Memory content
 * @param {Object} options - Optional settings
 * @returns {Object} The created memory
 */
export async function storeMemory(content, options = {}) {
    const collection = await getMemoriesCollection();
    const currentUser = process.env.CALQ_USER || 'unknown';

    const id = Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
    const metadata = {
        category: options.category || '',
        shared: options.shared !== false,
        projectId: options.project ? options.project.toLowerCase().trim() : '',
        clientId: options.client ? options.client.toLowerCase().trim().replace(/\s+/g, '-') : '',
        user: currentUser,
        createdAt: new Date().toISOString()
    };

    await collection.add({
        ids: [id],
        documents: [content],
        metadatas: [metadata]
    });

    // Also store in JSON for backup
    const data = loadData();
    if (!data.memories) data.memories = [];
    data.memories.push({ id, content, ...metadata });
    saveData(data);

    return { id, content, ...metadata };
}

/**
 * Search memories semantically using ChromaDB
 * @param {string} query - Search query
 * @param {Object} options - Filter options
 * @returns {Object[]} Matching memories
 */
export async function searchMemories(query, options = {}) {
    const collection = await getMemoriesCollection();
    const currentUser = process.env.CALQ_USER || 'unknown';
    const limit = options.limit || 5;

    // Build where filter
    const whereConditions = [];

    // Only show shared memories or own personal memories
    whereConditions.push({
        '$or': [
            { shared: true },
            { user: currentUser }
        ]
    });

    if (options.project) {
        whereConditions.push({ projectId: options.project.toLowerCase().trim() });
    }

    if (options.client) {
        whereConditions.push({ clientId: options.client.toLowerCase().trim().replace(/\s+/g, '-') });
    }

    const whereFilter = whereConditions.length > 1
        ? { '$and': whereConditions }
        : whereConditions[0] || {};

    try {
        const results = await collection.query({
            queryTexts: [query],
            nResults: limit,
            where: Object.keys(whereFilter).length > 0 ? whereFilter : undefined
        });

        if (!results.documents || !results.documents[0]) {
            return [];
        }

        return results.documents[0].map((doc, i) => ({
            id: results.ids[0][i],
            content: doc,
            ...results.metadatas[0][i],
            distance: results.distances ? results.distances[0][i] : null,
            relevanceScore: results.distances ? 1 - results.distances[0][i] : null
        }));
    } catch (error) {
        console.error('ChromaDB search error:', error.message);
        // Fallback to basic search if ChromaDB is not available
        return fallbackSearchMemories(query, options);
    }
}

/**
 * Fallback search when ChromaDB is not available
 */
function fallbackSearchMemories(query, options = {}) {
    const data = loadData();
    const currentUser = process.env.CALQ_USER || 'unknown';
    const limit = options.limit || 5;

    if (!data.memories) return [];

    const queryLower = query.toLowerCase();

    return data.memories
        .filter(m => {
            if (!m.shared && m.user !== currentUser) return false;
            if (options.project && m.projectId !== options.project.toLowerCase()) return false;
            if (options.client && m.clientId !== options.client.toLowerCase()) return false;
            return m.content.toLowerCase().includes(queryLower);
        })
        .slice(0, limit)
        .map(m => ({ ...m, relevanceScore: null }));
}

/**
 * Search time entries semantically
 * @param {string} query - Search query
 * @param {number} limit - Max results
 * @returns {Object[]} Matching entries
 */
export async function searchEntries(query, limit = 10) {
    const data = loadData();

    if (!data.entries || data.entries.length === 0) {
        return [];
    }

    // Filter entries with descriptions
    const entriesWithText = data.entries.filter(e => e.description && e.description.trim());

    if (entriesWithText.length === 0) {
        return [];
    }

    try {
        const collection = await getEntriesCollection();

        // Ensure entries are indexed
        const existingIds = (await collection.get()).ids;
        const newEntries = entriesWithText.filter(e => !existingIds.includes(e.id));

        if (newEntries.length > 0) {
            await collection.add({
                ids: newEntries.map(e => e.id),
                documents: newEntries.map(e => `${e.description} (${data.projects[e.project]?.name || e.project})`),
                metadatas: newEntries.map(e => ({
                    project: e.project,
                    minutes: e.minutes,
                    user: e.user || 'unknown',
                    createdAt: e.createdAt
                }))
            });
        }

        const results = await collection.query({
            queryTexts: [query],
            nResults: limit
        });

        if (!results.ids || !results.ids[0]) {
            return [];
        }

        return results.ids[0].map((id, i) => {
            const entry = entriesWithText.find(e => e.id === id);
            return {
                ...entry,
                projectName: data.projects[entry?.project]?.name || entry?.project,
                relevanceScore: results.distances ? 1 - results.distances[0][i] : null,
                durationFormatted: formatDuration(entry?.minutes || 0)
            };
        }).filter(Boolean);
    } catch (error) {
        console.error('ChromaDB entries search error:', error.message);
        // Fallback to basic search
        const queryLower = query.toLowerCase();
        return entriesWithText
            .filter(e => e.description.toLowerCase().includes(queryLower))
            .slice(0, limit)
            .map(e => ({
                ...e,
                projectName: data.projects[e.project]?.name || e.project,
                durationFormatted: formatDuration(e.minutes)
            }));
    }
}

/**
 * Delete a memory by ID
 * @param {string} memoryId - Memory ID to delete
 * @returns {Object|null} Deleted memory or null
 */
export async function deleteMemory(memoryId) {
    const data = loadData();

    if (!data.memories) {
        return null;
    }

    const index = data.memories.findIndex(m => m.id === memoryId);
    if (index === -1) return null;

    const deleted = data.memories.splice(index, 1)[0];
    saveData(data);

    // Also delete from ChromaDB
    try {
        const collection = await getMemoriesCollection();
        await collection.delete({ ids: [memoryId] });
    } catch (error) {
        console.error('ChromaDB delete error:', error.message);
    }

    return deleted;
}

/**
 * Get all memories (filtered by visibility)
 * @param {Object} options - Filter options
 * @returns {Object[]} Filtered memories
 */
export function getAllMemories(options = {}) {
    const data = loadData();
    const currentUser = process.env.CALQ_USER || 'unknown';

    let memories = (data.memories || []).filter(m => {
        // Check visibility
        if (!m.shared && m.user !== currentUser) return false;

        // Filter by category
        if (options.category && m.category?.toLowerCase() !== options.category.toLowerCase()) return false;

        // Filter by project
        if (options.project && m.projectId !== options.project.toLowerCase().trim()) return false;

        // Filter by client
        if (options.client && m.clientId !== options.client.toLowerCase().trim().replace(/\s+/g, '-')) return false;

        // Filter personal only
        if (options.personal && m.shared) return false;

        return true;
    });

    return memories.map(m => ({
        id: m.id,
        content: m.content,
        category: m.category,
        shared: m.shared,
        projectId: m.projectId,
        clientId: m.clientId,
        user: m.user,
        createdAt: m.createdAt
    }));
}
