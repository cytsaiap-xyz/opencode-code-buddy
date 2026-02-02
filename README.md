# OpenCode Code Buddy

🤖 **AI Development Assistant Plugin for OpenCode**

> 📴 **Fully Offline** - All core features work without internet

## ✨ Features

| Feature | Description |
|---------|-------------|
| 🧠 **Project Memory** | Record and retrieve decisions, patterns, lessons |
| 🎯 **Smart Tasks** | Analyze and track development tasks |
| 🔍 **Search** | Find past decisions and patterns |
| 📊 **Status** | Monitor plugin and session status |

## 🚀 Quick Installation

### Option 1: Project-Level (Recommended)

```bash
# Clone or download this repository
git clone https://github.com/YOUR_USERNAME/opencode-code-buddy.git

# Copy to your project
cp -r opencode-code-buddy/.opencode YOUR_PROJECT/

# Install dependencies
cd YOUR_PROJECT/.opencode/plugins/code-buddy
npm install
```

### Option 2: Global Installation

```bash
# Copy plugin to global config
cp -r opencode-code-buddy/.opencode/plugins/code-buddy ~/.config/opencode/plugins/

# Copy slash commands (optional)
cp -r opencode-code-buddy/.opencode/commands ~/.config/opencode/

# Install dependencies
cd ~/.config/opencode/plugins/code-buddy
npm install
```

## 📁 File Structure

After installation, your project should look like this:

```
your-project/
├── .opencode/
│   ├── plugins/
│   │   └── code-buddy.ts       # Plugin file (simple version)
│   │   └── code-buddy/         # Full plugin (for advanced features)
│   │       ├── package.json
│   │       ├── src/
│   │       │   └── index.ts
│   │       └── ...
│   └── commands/               # Slash commands
│       ├── buddy-do.md
│       ├── buddy-remember.md
│       ├── buddy-help.md
│       ├── buddy-status.md
│       └── buddy-add.md
└── opencode.json               # (optional)
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

### Direct Tool Calls

```
buddy_help()
buddy_do("Implement user login")
buddy_remember("authentication")
buddy_status()
buddy_add_memory("Title", "Content", "decision")
```

### CLI Mode

```bash
opencode run "buddy_help"
opencode run 'buddy_do("Your task here")'
```

## 📋 Available Commands

| Command | Arguments | Description |
|---------|-----------|-------------|
| `buddy_help` | none | Display help |
| `buddy_do` | `task: string` | Execute task |
| `buddy_remember` | `query: string` | Search memories |
| `buddy_add_memory` | `title, content, type` | Add memory |
| `buddy_status` | none | Show status |

### Memory Types

- `decision` - Important decisions
- `pattern` - Code patterns
- `bugfix` - Bug fixes
- `lesson` - Lessons learned
- `feature` - Features
- `note` - General notes

## ⚙️ Configuration

No configuration required! The plugin works out of the box.

Optional: Create `opencode.json` in your project root:

```json
{
    "$schema": "https://opencode.ai/config.json"
}
```

## 🔧 Troubleshooting

### Plugin Not Loading

1. Verify file exists: `ls .opencode/plugins/`
2. Install dependencies: `cd .opencode/plugins/code-buddy && npm install`
3. Restart OpenCode

### Commands Not Found

1. Run `buddy_help` to verify plugin is loaded
2. Check console for "[code-buddy] Plugin initialized" message

## 📄 License

MIT License

---

Made with ❤️ for the OpenCode community
