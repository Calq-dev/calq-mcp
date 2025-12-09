# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Calq MCP is a Model Context Protocol server for time tracking, project management, AI-powered memory, and team collaboration. It exposes MCP tools that Claude Desktop and other MCP clients can use.

## Development Commands

```bash
npm start          # Start the server
npm run dev        # Start with --watch for auto-reload
node --check src/index.js  # Syntax check before committing
```

## Docker Deployment

```bash
docker compose build && docker compose up -d   # Build and start
docker compose logs -f calq                     # View logs
```

The Docker setup uses:
- `chromadb/chroma:latest` for vector storage
- Healthcheck uses bash TCP check: `</dev/tcp/localhost/8000>` (no curl/python in image)
- Ports are configurable via `MCP_PORT` and `CHROMA_PORT` env vars

## Architecture

### Transport Layer
The server uses HTTP streaming transport (StreamableHTTPServerTransport) via Express:
- `POST /mcp` - Main MCP request endpoint
- `GET /mcp` - SSE streaming for server-sent events
- `DELETE /mcp` - Session cleanup
- Session management via `mcp-session-id` headers

### OAuth 2.1 Authentication (MCP SDK)
Full OAuth 2.1 with PKCE using the MCP SDK's `mcpAuthRouter`:
- `/.well-known/oauth-authorization-server` - OAuth metadata discovery
- `/.well-known/oauth-protected-resource` - Protected resource metadata
- `/register` - Dynamic client registration
- `/authorize` - Redirects to GitHub OAuth
- `/oauth/github/callback` - Handles GitHub callback, issues auth code
- `/token` - Exchanges auth code for access/refresh tokens

The `GitHubOAuthProvider` in `src/oauth-provider.js` implements `OAuthServerProvider`:
- Uses GitHub as identity provider
- Handles PKCE validation
- Issues JWT-like tokens stored in-memory (use Redis in production)
- `requireBearerAuth` middleware protects MCP endpoints (note: takes `verifier` object, not `verifyAccessToken` directly)

### Data Layer
- **SQLite** (`~/.calq/calq.db`): Source of truth for all structured data (users, projects, clients, entries, memories metadata, active timers)
- **ChromaDB**: Vector store for semantic search. Stores embeddings for memories and time entries using Voyage AI embeddings

### Module Structure
- `src/index.js` - MCP server setup, Express routes, OAuth endpoints, tool definitions using `@modelcontextprotocol/sdk`
- `src/oauth-provider.js` - OAuth 2.1 provider implementing MCP SDK's `OAuthServerProvider` interface
- `src/storage.js` - SQLite database operations, schema initialization, all CRUD functions
- `src/memory.js` - ChromaDB integration for vector search (memories and entries)
- `src/auth.js` - Legacy OAuth helpers (being phased out)

### Request Context Pattern
User authentication flows through `AsyncLocalStorage` to make the current user available in tool handlers without explicit passing. The `checkUser()` helper retrieves the authenticated user from context.

### Key Patterns
- Tool handlers use Zod for input validation
- Projects are auto-created on first time entry (via `getOrCreateProject`)
- Entries are indexed in ChromaDB asynchronously after creation
- First user to authenticate becomes admin
- Express needs `app.set('trust proxy', 1)` when behind nginx (for rate limiting)

## Git Workflow

Branch from `main`, use conventional commits:
- `feat:` new features
- `fix:` bug fixes
- `docs:` documentation
- `refactor:` code changes
- `chore:` maintenance tasks

Branch naming: `feature/xxx`, `fix/xxx`, `docs/xxx`

**Do not add co-author lines to commits.**

## Environment Variables

Required:
- `VOYAGE_API_KEY` - Voyage AI for embeddings
- `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` - GitHub OAuth app credentials

Optional:
- `BASE_URL` - Public URL of server (e.g., `https://mcp.calq.nl`)
- `CHROMA_URL` (default: `http://localhost:8000`)
- `MCP_PORT` (default: `3000`)
- `CHROMA_PORT` (default: `8000`)
- `CALQ_DATA_DIR` (default: `~/.calq`)
- `COMPOSE_PROJECT_NAME` - Docker compose project name

## Production Checklist

- Set `BASE_URL` to your public domain
- Configure GitHub OAuth callback URL to `{BASE_URL}/oauth/github/callback`
- Enable `trust proxy` in Express when behind nginx/load balancer
- Consider Redis for token storage instead of in-memory Maps
