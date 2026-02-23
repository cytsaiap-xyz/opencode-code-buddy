# Code Buddy MCP Server

AI Development Assistant — Project Memory, Knowledge Graph, Error Learning, Workflow Guidance.

- Fully offline — all features work without internet
- Persistent JSON storage at `~/.config/code-buddy/data/`
- Works with any MCP-compatible client (Claude Code, Cursor, etc.)

## Installation

```bash
# Clone and build
git clone https://github.com/cytsaiap-xyz/opencode-code-buddy.git
cd opencode-code-buddy
npm install
npm run build
```

### Configure in your MCP client

**Claude Code** (`~/.claude/settings.json`):

```json
{
  "mcpServers": {
    "code-buddy": {
      "command": "node",
      "args": ["/path/to/opencode-code-buddy/dist/index.js"]
    }
  }
}
```

**OpenCode** (`opencode.json`):

```json
{
  "mcp": {
    "code-buddy": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/opencode-code-buddy/dist/index.js"]
    }
  }
}
```

## Tools (17)

### Task Management

| Tool | Description |
|------|-------------|
| `buddy_do` | Start a task — analyzes type/complexity, records to memory |
| `buddy_done` | Record task completion with results and learnings |

### Memory

| Tool | Description |
|------|-------------|
| `buddy_remember` | Search memories by query |
| `buddy_remember_recent` | Get most recent memories |
| `buddy_remember_by_category` | Filter by solution or knowledge |
| `buddy_remember_stats` | Memory and graph statistics |
| `buddy_add_memory` | Add memory with deduplication |
| `buddy_delete_memory` | Delete memories (two-step confirmation) |

### Knowledge Graph

| Tool | Description |
|------|-------------|
| `buddy_create_entity` | Create a knowledge entity |
| `buddy_search_entities` | Search entities |
| `buddy_create_relation` | Create entity relationship |

### Error Learning

| Tool | Description |
|------|-------------|
| `buddy_record_mistake` | Record an AI mistake |
| `buddy_get_mistake_patterns` | Analyze mistake patterns |

### Workflow

| Tool | Description |
|------|-------------|
| `buddy_get_workflow_guidance` | Phase-based guidance and next steps |
| `buddy_get_session_health` | Session productivity metrics |

## Data Storage

All data is stored as JSON files in `~/.config/code-buddy/data/`:

```
~/.config/code-buddy/data/
├── memory.json       # Memories (decisions, patterns, lessons, etc.)
├── entities.json     # Knowledge graph entities
├── relations.json    # Entity relationships
└── mistakes.json     # Recorded AI mistakes
```

## Memory Types

| Type | Category | Purpose |
|------|----------|---------|
| `decision` | solution | Architectural/technical decisions |
| `bugfix` | solution | Bug fixes and their solutions |
| `lesson` | solution | Lessons learned |
| `pattern` | knowledge | Reusable coding patterns |
| `feature` | knowledge | Feature implementations |
| `note` | knowledge | General notes |

## Deduplication

When adding memories, Jaccard similarity (threshold: 0.35) is checked against existing entries. If a similar memory is found, you'll be prompted to use `forceSave=true` to save anyway.

## License

MIT
