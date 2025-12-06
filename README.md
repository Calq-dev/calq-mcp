# Time Tracker MCP Server

A simple MCP server for tracking time spent on projects. Use it from Claude Code or Claude Desktop to log time with natural language.

## Features

### Timer
- **`start`** - Start timing a task ("I'm gonna start working on this now")
- **`stop`** - Stop the timer and log the time ("Finished that task!")
- **`timer_status`** - Check if a timer is running
- **`cancel_timer`** - Discard timer without saving

### Logging
- **`commit`** - Log time and/or a summary to a project. Billable by default.
- **`delete`** - Remove an entry (last one by default, or by ID)
- **`edit`** - Modify an existing entry (message, minutes, project, billable, or billed status)

### Summaries
- **`list_projects`** - View all projects with total time spent
- **`get_project_summary`** - Get detailed entries for a specific project
- **`get_today_summary`** - View all work done today
- **`get_weekly_summary`** - View this week's summary
- **`get_unbilled`** - View unbilled billable time by project

## Installation

```bash
cd /path/to/time-tracker-mcp
npm install
```

## Usage Examples

Once connected, you can use natural language in Claude:

**Timer workflow:**
- *"Start timing the website project: Working on the navigation"*
- *"Stop the timer"* (or *"Finished!"*)

**Direct logging:**
- *"Commit 30 minutes to the website project: Fixed the navigation menu"*
- *"Log 15 minutes to internal meeting, non-billable"*

**Managing entries:**
- *"Delete the last entry"*
- *"Mark entry abc123 as billed"*

**Summaries:**
- *"What's my unbilled time?"*
- *"Show me my projects"*
- *"What did I work on today?"*

## Configuration

### Claude Desktop

Add to your `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "time-tracker": {
      "command": "node",
      "args": ["/full/path/to/time-tracker-mcp/src/index.js"]
    }
  }
}
```

### Claude Code

Add to your MCP settings:

```json
{
  "time-tracker": {
    "command": "node",
    "args": ["/full/path/to/time-tracker-mcp/src/index.js"]
  }
}
```

## Docker

Build the image:

```bash
docker build -t time-tracker-mcp .
```

Use in Claude Desktop config:

```json
{
  "mcpServers": {
    "time-tracker": {
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "-v", "time-tracker-data:/data",
        "time-tracker-mcp"
      ]
    }
  }
}
```

## Data Storage

Time entries are stored in `~/.time-tracker-mcp/data.json` (or in a Docker volume when using containers).

## License

MIT
