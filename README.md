# Calq MCP

A Model Context Protocol (MCP) server for time tracking, project management, AI-powered memory, and team collaboration.

## Features

### 🌐 Transport Modes
- **Stdio** (default) - For local Claude Desktop/Code integration
- **HTTP Streaming** - For remote deployment with SSE support

### ⏱️ Time Tracking
- **Timer system** - Start/stop timers for real-time tracking
- **Manual logging** - Log time with backdating support
- **Billing** - Mark entries as billable/billed, track unbilled time

### 🧠 AI-Powered Memory
- **Semantic search** - Find memories and entries by meaning, not just keywords
- **Personal & shared** - Keep notes private or share with your team
- **Project/client linking** - Associate memories with specific projects or clients
- **Vector storage** - [ChromaDB](https://trychroma.com) for scalable embeddings
- Powered by [Voyage AI](https://voyageai.com) embeddings

### 👥 Team Collaboration
- **GitHub OAuth** - Authenticate team members via GitHub
- **Role-based access** - Admin and member roles
- **User tracking** - All entries tagged with user identity

### 📊 Project & Client Management
- **Clients** - Manage client information
- **Projects** - Link projects to clients with hourly rates
- **Invoice summaries** - Get unbilled time grouped by client with calculated values

## Installation

### Prerequisites
- Node.js 18+
- Docker (optional)

### Local Setup

```bash
git clone https://github.com/Calq-dev/calq-mcp.git
cd calq-mcp
npm install
```

### Docker

```bash
docker build -t calq-mcp .
```

## Configuration

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "calq": {
      "command": "node",
      "args": ["/path/to/calq-mcp/src/index.js"],
      "env": {
        "VOYAGE_API_KEY": "your-voyage-api-key",
        "GITHUB_CLIENT_ID": "your-github-client-id",
        "GITHUB_CLIENT_SECRET": "your-github-client-secret",
        "CALQ_USER": "your-github-username"
      }
    }
  }
}
```

### Docker Configuration (HTTP Mode)

```bash
# Build
docker build -t calq-mcp .

# Run in HTTP streaming mode
docker run -d --name calq \
  -p 3000:3000 \
  -p 3847:3847 \
  -v calq-data:/data \
  -e VOYAGE_API_KEY=your-key \
  -e GITHUB_CLIENT_ID=your-id \
  -e GITHUB_CLIENT_SECRET=your-secret \
  calq-mcp
```

Then connect via: `http://localhost:3000/mcp`

### Docker Configuration (Stdio Mode)

For Claude Desktop with stdio:

```json
{
  "mcpServers": {
    "calq": {
      "command": "docker",
      "args": ["run", "-i", "--rm", "-v", "calq-data:/data", "-e", "MCP_MODE=stdio", "calq-mcp"],
      "env": {
        "VOYAGE_API_KEY": "your-voyage-api-key",
        "GITHUB_CLIENT_ID": "your-github-client-id",
        "GITHUB_CLIENT_SECRET": "your-github-client-secret",
        "CALQ_USER": "your-github-username"
      }
    }
  }
}
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `MCP_MODE` | No | `stdio` (default) or `http` |
| `MCP_PORT` | No | HTTP port (default: 3000) |
| `VOYAGE_API_KEY` | Yes | Voyage AI API key for memory features |
| `GITHUB_CLIENT_ID` | For auth | GitHub OAuth App client ID |
| `GITHUB_CLIENT_SECRET` | For auth | GitHub OAuth App client secret |
| `CALQ_USER` | Yes | Your GitHub username (after OAuth login) |
| `AUTH_PORT` | No | Auth server port (default: 3847) |

## GitHub OAuth Setup

1. Go to [GitHub Developer Settings](https://github.com/settings/developers)
2. Click "New OAuth App"
3. Fill in:
   - **Application name:** Calq
   - **Homepage URL:** http://localhost:3847
   - **Authorization callback URL:** http://localhost:3847/callback
4. Copy the Client ID and generate a Client Secret
5. Add both to your MCP configuration

## Tools

### Time Tracking

| Tool | Description |
|------|-------------|
| `commit` | Log time with message, project, and optional date |
| `start` | Start a timer for a project |
| `stop` | Stop timer and log the time |
| `timer_status` | Check if a timer is running |
| `cancel_timer` | Discard timer without logging |
| `delete` | Delete a time entry |
| `edit` | Modify an existing entry |

### Summaries

| Tool | Description |
|------|-------------|
| `list_projects` | List all projects with total time |
| `list_projects_detailed` | Projects with client info and values |
| `get_project_summary` | Detailed summary for a project |
| `get_today_summary` | Today's time by project |
| `get_weekly_summary` | This week's time by day |
| `get_unbilled` | Unbilled time summary |
| `get_invoice_summary` | Unbilled time by client with values |

### Memory

| Tool | Description |
|------|-------------|
| `remember` | Store a memory (personal/shared, linked to project/client) |
| `recall` | Search memories semantically |
| `search_entries` | Search time entries semantically |
| `list_memories` | List all memories |
| `forget` | Delete a memory |

### Clients & Projects

| Tool | Description |
|------|-------------|
| `add_client` | Add a new client |
| `list_clients` | List all clients |
| `configure_project` | Create/update project with client and hourly rate |

### Users (with OAuth)

| Tool | Description |
|------|-------------|
| `whoami` | Show current user info |
| `list_users` | List all users (admin only) |
| `set_user_role` | Change user role (admin only) |
| `team_summary` | Team activity summary |

## Usage Examples

```
"Start timing the website project"
"Stop - finished the navbar"
"Log 2 hours to API work yesterday: implemented auth"
"Remember: client wants deadline moved to January"
"Recall: what did the client say about deadlines?"
"What's my unbilled time for Acme Corp?"
"Configure project website with client Acme and rate 95"
```

## Data Storage

Data is stored in `~/.calq/data.json` (or `/data/.calq/data.json` in Docker with volume mount).

## License

MIT
