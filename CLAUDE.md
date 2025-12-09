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

## Architecture

### Transport Layer
The server uses HTTP streaming transport (not stdio) via Express. MCP requests go to `POST /mcp` with session management via `mcp-session-id` headers.

### Data Layer
- **SQLite** (`~/.calq/calq.db`): Source of truth for all structured data (users, projects, clients, entries, memories metadata, active timers)
- **ChromaDB**: Vector store for semantic search. Stores embeddings for memories and time entries using Voyage AI embeddings

### Module Structure
- `src/index.js` - MCP server setup, Express routes, OAuth endpoints, tool definitions using `@modelcontextprotocol/sdk`
- `src/storage.js` - SQLite database operations, schema initialization, all CRUD functions
- `src/memory.js` - ChromaDB integration for vector search (memories and entries)
- `src/auth.js` - GitHub OAuth flow, user session management

### Request Context Pattern
User authentication flows through `AsyncLocalStorage` to make the current user available in tool handlers without explicit passing. The `checkUser()` helper retrieves the authenticated user from context.

### Key Patterns
- Tool handlers use Zod for input validation
- Projects are auto-created on first time entry (via `getOrCreateProject`)
- Entries are indexed in ChromaDB asynchronously after creation
- First user to authenticate becomes admin

## Git Workflow

Branch from `develop`, use conventional commits:
- `feat:` new features
- `fix:` bug fixes
- `docs:` documentation
- `refactor:` code changes

Branch naming: `feature/xxx`, `fix/xxx`, `docs/xxx`

**Do not add co-author lines to commits.**

## Environment Variables

Required:
- `VOYAGE_API_KEY` - Voyage AI for embeddings
- `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` - OAuth

Optional:
- `CHROMA_URL` (default: `http://localhost:8000`)
- `MCP_PORT` (default: `3000`)
- `CALQ_DATA_DIR` (default: `~/.calq`)
