# Calq MCP

A Model Context Protocol (MCP) server for time tracking, project management, AI-powered memory, and team collaboration.

## Features

### ⏱️ Time Tracking
- **Timer system** - Start/stop timers for real-time tracking
- **Manual logging** - Log time with backdating support
- **Billing** - Mark entries as billable/billed, track unbilled time

### 🧠 AI-Powered Memory
- **Semantic search** - Find memories and entries by meaning, not just keywords
- **Personal & shared** - Keep notes private or share with your team
- **Project/client linking** - Associate memories with specific projects or clients
- **Vector storage** - Powered by [ChromaDB](https://trychroma.com) and [Voyage AI](https://voyageai.com) embeddings

### 👥 Team Collaboration
- **GitHub OAuth** - Authenticate team members via GitHub (integrated into MCP flow)
- **Role-based access** - Admin and member roles
- **Per-user data** - Timers and entries are user-scoped

### 📊 Project & Client Management
- **Clients** - Manage client information
- **Projects** - Link projects to clients with hourly rates
- **Invoice summaries** - Get unbilled time grouped by client with calculated values

## Prerequisites

- Node.js 20+
- **ChromaDB** - Vector database for semantic search
- **Voyage AI API key** - For generating embeddings
- **GitHub OAuth App** - For user authentication

## Installation

### Option 1: Docker Compose (Recommended)

This automatically sets up both Calq and ChromaDB:

```bash
git clone https://github.com/Calq-dev/calq-mcp.git
cd calq-mcp

# Copy and configure environment
cp .env.example .env
# Edit .env with your API keys

# Start services
docker compose up -d
```

Services:
- **Calq MCP**: `http://localhost:3000/mcp`
- **ChromaDB**: `http://localhost:8000` (internal)

### Option 2: Local Development

```bash
# 1. Start ChromaDB (required for memory features)
docker run -d --name chromadb -p 8000:8000 chromadb/chroma:latest

# 2. Clone and install
git clone https://github.com/Calq-dev/calq-mcp.git
cd calq-mcp
npm install

# 3. Configure environment
cp .env.example .env
# Edit .env with your API keys

# 4. Start the server
node src/index.js
```

## Configuration

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `VOYAGE_API_KEY` | Yes | Voyage AI API key for embeddings |
| `CHROMA_URL` | No | ChromaDB URL (default: `http://localhost:8000`) |
| `GITHUB_CLIENT_ID` | Yes | GitHub OAuth App client ID |
| `GITHUB_CLIENT_SECRET` | Yes | GitHub OAuth App client secret |
| `MCP_PORT` | No | Server port (default: 3000) |
| `OAUTH_CALLBACK_URL` | No | OAuth callback (default: `http://localhost:3000/oauth/callback`) |

### GitHub OAuth Setup

1. Go to [GitHub Developer Settings](https://github.com/settings/developers)
2. Click "New OAuth App"
3. Fill in:
   - **Application name:** Calq
   - **Homepage URL:** `http://localhost:3000`
   - **Authorization callback URL:** `http://localhost:3000/oauth/callback`
4. Copy the Client ID and generate a Client Secret
5. Add both to your `.env` file

### Claude Desktop Configuration

Add to your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "calq": {
      "url": "http://localhost:3000/mcp"
    }
  }
}
```

When you first use Calq, Claude Desktop will open a browser for GitHub authentication.

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
| `idea` | Quick capture an idea |
| `recall` | Search memories semantically |
| `search_entries` | Search time entries semantically |
| `list_memories` | List all memories |
| `list_ideas` | List all captured ideas |
| `forget` | Delete a memory |

### Clients & Projects

| Tool | Description |
|------|-------------|
| `add_client` | Add a new client |
| `list_clients` | List all clients |
| `configure_project` | Create/update project with client and hourly rate |

### Users

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

## Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  Claude Desktop │────▶│   Calq MCP      │────▶│    ChromaDB     │
│                 │     │  (Port 3000)    │     │  (Port 8000)    │
└─────────────────┘     └────────┬────────┘     └─────────────────┘
                                 │
                                 ▼
                        ┌─────────────────┐
                        │     SQLite      │
                        │  (~/.calq/)     │
                        └─────────────────┘
```

- **SQLite** - Source of truth for structured data (entries, projects, users)
- **ChromaDB** - Vector store for semantic search (memories, entry embeddings)

## Data Storage

- **SQLite database**: `~/.calq/calq.db`
- **ChromaDB**: Embeddings stored in ChromaDB container/instance

In Docker, data is persisted via volumes:
- `calq-data` - SQLite database
- `chroma-data` - ChromaDB embeddings

## License

MIT
