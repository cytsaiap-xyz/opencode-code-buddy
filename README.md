# OpenCode Code Buddy

🤖 **AI Development Assistant Plugin for OpenCode** (v2.0)

> 📴 **Fully Offline** - All core features work without internet  
> 💾 **Persistent Storage** - Memories saved to local files  
> 🔗 **Knowledge Graph** - Track entities and relationships  
> 🤖 **Full Auto Observer** - Automatic task/decision/error recording

## ✨ Features

| Feature                   | Description                                        |
| ------------------------- | -------------------------------------------------- |
| 🧠 **Project Memory**     | Persistent storage of decisions, patterns, lessons |
| 🔗 **Knowledge Graph**    | Manage entities and their relationships            |
| 🎯 **Smart Tasks**        | AI-enhanced task analysis and tracking             |
| 📝 **Error Learning**     | Record mistakes to prevent repetition              |
| 📋 **Workflow Guidance**  | Development phase recommendations                  |
| 💚 **Session Health**     | Monitor work session productivity                  |
| 🤖 **Full Auto Observer** | Auto-detect tasks, decisions, errors               |
| 🏷️ **AI Auto-Tag**        | Automatic tag generation for memories              |
| 🔄 **Deduplication**      | Jaccard + LLM similarity detection                 |

## 🚀 Installation

### Quick Install (Recommended)

```bash
# Clone the repository
git clone https://github.com/cytsaiap-xyz/opencode-code-buddy.git

# Run install script (installs globally to ~/.config/opencode/)
cd opencode-code-buddy
./install.sh
```

### Manual Install

```bash
# Clone
git clone https://github.com/cytsaiap-xyz/opencode-code-buddy.git

# Create directories
mkdir -p ~/.config/opencode/plugins
mkdir -p ~/.config/opencode/commands
mkdir -p ~/.config/opencode/code-buddy

# Copy plugin (single file)
cp opencode-code-buddy/.opencode/plugins/code-buddy.ts ~/.config/opencode/plugins/

# Copy default config
cp opencode-code-buddy/.opencode/code-buddy/config.json ~/.config/opencode/code-buddy/

# Copy slash commands
cp opencode-code-buddy/.opencode/commands/*.md ~/.config/opencode/commands/
```

## 📁 File Structure

### Repository

```
opencode-code-buddy/
├── .opencode/
│   ├── plugins/
│   │   └── code-buddy.ts          # Plugin source (single file)
│   ├── commands/                   # Slash commands (19 .md files)
│   │   ├── buddy-do.md
│   │   ├── buddy-remember.md
│   │   ├── buddy-help.md
│   │   └── ...
│   └── code-buddy/
│       └── config.json             # Default config (LLM + Hooks)
├── README.md
├── USAGE_GUIDE.md
├── MEMORY_SYSTEM.md
├── code-buddy-flowchart.drawio     # Architecture diagram
├── install.sh
├── package.json
└── .gitignore
```

### After Installation

```
your-project/
├── .opencode/
│   ├── plugins/
│   │   └── code-buddy.ts          # Plugin
│   ├── commands/                   # Slash commands
│   │   └── buddy-*.md
│   └── code-buddy/
│       ├── config.json             # Config (edit this!)
│       └── data/                   # Auto-created at runtime
│           ├── memory.json
│           ├── entities.json
│           ├── relations.json
│           └── mistakes.json
```

## 💻 Usage

### Slash Commands

| Command                   | Description                |
| ------------------------- | -------------------------- |
| `/buddy-help`             | Show all commands          |
| `/buddy-do <task>`        | Execute and analyze a task |
| `/buddy-done`             | Record task completion     |
| `/buddy-remember <query>` | Search memories            |
| `/buddy-recent`           | Recent memories            |
| `/buddy-add <content>`    | Add a memory               |
| `/buddy-delete`           | Delete a memory            |
| `/buddy-status`           | Plugin status              |
| `/buddy-stats`            | Memory statistics          |
| `/buddy-category`         | Browse by category         |
| `/buddy-entity`           | Create entity              |
| `/buddy-mistake`          | Record mistake             |
| `/buddy-patterns`         | Error analysis             |
| `/buddy-workflow`         | Workflow guidance          |
| `/buddy-health`           | Session health             |
| `/buddy-config`           | Configuration              |
| `/buddy-ai`               | AI operations              |
| `/buddy-analyze`          | Code analysis              |
| `/buddy-suggest`          | Improvement suggestions    |

### All Available Tools (21)

| Tool                          | Description                |
| ----------------------------- | -------------------------- |
| `buddy_help`                  | Display help               |
| `buddy_config`                | View/edit config           |
| `buddy_do`                    | Execute task with analysis |
| `buddy_done`                  | Record task completion     |
| `buddy_remember`              | Search memories            |
| `buddy_remember_recent`       | Get recent memories        |
| `buddy_remember_by_category`  | Browse by category         |
| `buddy_remember_stats`        | Memory statistics          |
| `buddy_add_memory`            | Add memory (+ AI auto-tag) |
| `buddy_delete_memory`         | Delete memory              |
| `buddy_create_entity`         | Create knowledge entity    |
| `buddy_search_entities`       | Search entities            |
| `buddy_create_relation`       | Create entity relation     |
| `buddy_record_mistake`        | Record AI mistake          |
| `buddy_get_mistake_patterns`  | Error pattern analysis     |
| `buddy_get_workflow_guidance` | Workflow guidance          |
| `buddy_get_session_health`    | Session health check       |
| `buddy_ask_ai`                | Ask AI a question          |
| `buddy_analyze_code`          | AI code analysis           |
| `buddy_suggest_improvements`  | AI improvement suggestions |

## 🤖 Full Auto Observer Mode

When enabled (default), Code Buddy **automatically** records everything:

| What          | How                                        |
| ------------- | ------------------------------------------ |
| **Tasks**     | Detects what you're working on             |
| **Decisions** | Identifies architectural choices           |
| **Errors**    | Scans tool output for error patterns       |
| **Context**   | Injects memories during session compaction |

No manual commands needed — just code normally.

### Configuration

Edit `.opencode/code-buddy/config.json`:

```json
{
  "hooks": {
    "fullAuto": true,
    "autoErrorDetect": true,
    "autoObserve": true,
    "observeMinActions": 3
  }
}
```

## 🤖 AI Integration (Optional)

Connect to vLLM, Ollama, or any OpenAI-compatible API:

```
buddy_config()  # View current config
```

Edit `config.json` to set your API key and model.

> ⚠️ AI is optional. All core features work fully offline.

## 📖 Documentation

- [USAGE_GUIDE.md](./USAGE_GUIDE.md) - Detailed usage guide
- [MEMORY_SYSTEM.md](./MEMORY_SYSTEM.md) - Memory system internals

## 📄 License

MIT License

---

Made with ❤️ for the OpenCode community

🔗 [GitHub](https://github.com/cytsaiap-xyz/opencode-code-buddy)
