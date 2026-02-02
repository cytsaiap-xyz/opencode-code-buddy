# OpenCode Code Buddy

🤖 **AI Development Assistant Plugin for OpenCode** (Full Version)

> 📴 **Fully Offline** - All core features work without internet  
> 💾 **Persistent Storage** - Memories saved to local files  
> 🔗 **Knowledge Graph** - Track entities and relationships

## ✨ Features

| Feature | Description |
|---------|-------------|
| 🧠 **Project Memory** | Persistent storage of decisions, patterns, lessons |
| 🔗 **Knowledge Graph** | Manage entities and their relationships |
| 🎯 **Smart Tasks** | AI-enhanced task analysis and tracking |
| 📝 **Error Learning** | Record mistakes to prevent repetition |
| 📋 **Workflow Guidance** | Development phase recommendations |
| 💚 **Session Health** | Monitor work session productivity |
| 🤖 **AI Integration** | Optional vLLM/Ollama support |

## 🚀 Installation

### Quick Install (Recommended)

```bash
# Clone the repository
git clone https://github.com/cytsaiap-xyz/opencode-code-buddy.git

# Run install script
cd opencode-code-buddy
./install.sh /path/to/your/project

# Or install to current directory
./install.sh .
```

### Manual Install

```bash
# Clone
git clone https://github.com/cytsaiap-xyz/opencode-code-buddy.git

# Copy to project
mkdir -p YOUR_PROJECT/.opencode/plugins/code-buddy
cp -r opencode-code-buddy/src YOUR_PROJECT/.opencode/plugins/code-buddy/
cp opencode-code-buddy/package.json YOUR_PROJECT/.opencode/plugins/code-buddy/
cp opencode-code-buddy/tsconfig.json YOUR_PROJECT/.opencode/plugins/code-buddy/

# Copy slash commands
cp -r opencode-code-buddy/.opencode/commands YOUR_PROJECT/.opencode/

# Install dependencies
cd YOUR_PROJECT/.opencode/plugins/code-buddy
npm install
```

### Global Install

```bash
# Copy to global config
./install.sh ~/.config/opencode
```

## 📁 File Structure

After installation:

```
your-project/
├── .opencode/
│   ├── plugins/
│   │   └── code-buddy/         # Full plugin
│   │       ├── package.json
│   │       ├── tsconfig.json
│   │       └── src/
│   │           ├── index.ts
│   │           ├── memory/
│   │           ├── commands/
│   │           ├── workflow/
│   │           ├── ai/
│   │           └── utils/
│   ├── commands/               # Slash commands
│   │   ├── buddy-do.md
│   │   ├── buddy-remember.md
│   │   ├── buddy-help.md
│   │   ├── buddy-status.md
│   │   └── buddy-add.md
│   └── code-buddy/
│       └── data/               # Persistent storage (auto-created)
│           ├── memory.json
│           ├── graph.json
│           └── ...
```

## 💻 Usage

### Slash Commands

| Command | Description |
|---------|-------------|
| `/buddy-help` | Show all commands |
| `/buddy-do <task>` | Execute and analyze a task |
| `/buddy-remember <query>` | Search memories |
| `/buddy-status` | Show plugin status |
| `/buddy-add <content>` | Add a memory |

### All Available Tools

| Tool | Description |
|------|-------------|
| `buddy_help` | Display help |
| `buddy_do` | Execute task with analysis |
| `buddy_remember` | Search memories |
| `buddy_remember_recent` | Get recent memories |
| `buddy_remember_stats` | Memory statistics |
| `buddy_add_memory` | Add memory entry |
| `buddy_create_entity` | Create knowledge entity |
| `buddy_search_entities` | Search entities |
| `buddy_create_relation` | Create entity relation |
| `buddy_record_mistake` | Record AI mistake |
| `buddy_get_mistake_patterns` | Error pattern analysis |
| `buddy_get_workflow_guidance` | Workflow guidance |
| `buddy_get_session_health` | Session health check |
| `buddy_configure_ai` | Configure vLLM |
| `buddy_test_ai_connection` | Test AI connection |
| `buddy_get_ai_status` | AI configuration status |

### CLI Mode

```bash
opencode run "buddy_help"
opencode run 'buddy_do("Implement user login")'
opencode run 'buddy_remember("authentication")'
```

## 🤖 AI Integration (Optional)

Connect to vLLM, Ollama, or any OpenAI-compatible API:

```
buddy_configure_ai("http://localhost:11434/v1", "codellama")
buddy_test_ai_connection()
```

> ⚠️ AI is optional. All core features work fully offline.

## 📖 Documentation

See [USAGE_GUIDE.md](./USAGE_GUIDE.md) for detailed documentation.

## 📄 License

MIT License

---

Made with ❤️ for the OpenCode community

🔗 [GitHub](https://github.com/cytsaiap-xyz/opencode-code-buddy)
