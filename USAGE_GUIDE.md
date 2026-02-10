# OpenCode Code Buddy - Usage Guide

A comprehensive guide for using the Code Buddy plugin in OpenCode.

## Table of Contents

1. [Installation](#installation)
2. [Getting Started](#getting-started)
3. [Core Commands](#core-commands)
4. [Memory System](#memory-system)
5. [Knowledge Graph](#knowledge-graph)
6. [Error Learning](#error-learning)
7. [Workflow Guidance](#workflow-guidance)
8. [AI Integration](#ai-integration)
9. [Hook System](#hook-system)
10. [Best Practices](#best-practices)
11. [Troubleshooting](#troubleshooting)

---

## Installation

### Method 1: Project-Level Installation (Recommended)

Copy the plugin to your project's plugins directory:

```bash
# Navigate to your project
cd /path/to/your/project

# Create plugins directory if it doesn't exist
mkdir -p .opencode/plugins

# Copy code-buddy plugin
cp -r /path/to/code-buddy .opencode/plugins/

# Install dependencies
cd .opencode/plugins/code-buddy
npm install
```

### Method 2: Global Installation

Copy the plugin to your global OpenCode plugins directory:

```bash
# Copy to global plugins directory
cp -r /path/to/code-buddy ~/.config/opencode/plugins/

# Install dependencies
cd ~/.config/opencode/plugins/code-buddy
npm install
```

### Verify Installation

After copying and restarting OpenCode, verify the plugin is loaded:

```
buddy_help()
```

You should see a list of all available commands.

---

## Getting Started

### Quick Start Example

```
# 1. Start a new task
buddy_do("Implement user registration API endpoint")

# 2. The plugin will:
#    - Analyze task type (implement)
#    - Estimate complexity
#    - Suggest execution steps
#    - Record to project memory

# 3. Later, recall this decision
buddy_remember("registration")
```

### Basic Workflow

1. **Before coding**: Use `buddy_do` to record and analyze your task
2. **During coding**: Use `buddy_add_memory` to record important decisions
3. **After issues**: Use `buddy_record_mistake` to learn from errors
4. **When revisiting**: Use `buddy_remember` to recall past decisions

---

## Core Commands

### buddy_do(task)

Execute and analyze a development task.

**Arguments:**

- `task` (string, required): Description of the task

**Examples:**

```
# Implement a new feature
buddy_do("Implement user login with JWT authentication")

# Fix a bug
buddy_do("Fix memory leak in WebSocket connection handler")

# Refactor code
buddy_do("Refactor database access layer to use repository pattern")

# Research a topic
buddy_do("Research best practices for GraphQL pagination")
```

**What it does:**

1. Analyzes task type (implement, fix, refactor, research, etc.)
2. Estimates complexity (low, medium, high)
3. Generates suggested execution steps
4. Creates a memory entry
5. Creates a knowledge graph entity

### buddy_help([command])

Display help documentation.

**Examples:**

```
# Show all commands
buddy_help()

# Show specific command help
buddy_help("buddy_do")
buddy_help("buddy_remember")
```

---

## Memory System

The memory system stores project decisions, patterns, and lessons learned.

### buddy_remember(query, [limit], [type])

Search through project memories.

**Arguments:**

- `query` (string, required): Search keywords
- `limit` (number, optional): Max results (default: 5)
- `type` (string, optional): Filter by type

**Types:** decision, pattern, bugfix, lesson, feature, note

**Examples:**

```
# Search for authentication-related memories
buddy_remember("authentication")

# Search with limit
buddy_remember("database", 10)

# Search by type
buddy_remember("login", 5, "decision")
```

### buddy_remember_recent([limit])

Get most recent memories.

**Examples:**

```
# Get last 5 memories
buddy_remember_recent()

# Get last 10 memories
buddy_remember_recent(10)
```

### buddy_remember_stats()

Get memory statistics.

**Example:**

```
buddy_remember_stats()

# Returns:
# - Total entries
# - Entries by type
# - Recent activity
# - Knowledge graph stats
```

### buddy_add_memory(title, content, type, [tags])

Manually add a memory entry.

**Arguments:**

- `title` (string, required): Memory title
- `content` (string, required): Memory content
- `type` (string, required): Memory type
- `tags` (string[], optional): Tags

**Examples:**

```
# Record a decision
buddy_add_memory(
  "Use PostgreSQL for primary database",
  "Chose PostgreSQL over MySQL for better JSON support and full-text search",
  "decision",
  ["database", "infrastructure"]
)

# Record a lesson learned
buddy_add_memory(
  "Always validate input at API boundary",
  "Learned that trusting frontend validation led to data corruption issues",
  "lesson",
  ["validation", "api"]
)
```

---

## Knowledge Graph

The knowledge graph manages entities and their relationships.

### buddy_create_entity(name, type, observations, [tags])

Create a knowledge entity.

**Arguments:**

- `name` (string, required): Entity name
- `type` (string, required): Entity type
- `observations` (string[], required): List of facts/observations
- `tags` (string[], optional): Tags

**Types:** decision, feature, component, file, bug_fix, lesson, pattern, technology

**Examples:**

```
# Record a feature
buddy_create_entity(
  "JWT Authentication",
  "feature",
  ["Uses RS256 algorithm", "Tokens expire in 15 minutes", "Refresh tokens valid for 7 days"],
  ["auth", "security"]
)

# Record a component
buddy_create_entity(
  "UserService",
  "component",
  ["Handles user CRUD", "Integrates with AuthService", "Uses caching"],
  ["service", "user"]
)

# Record a technology choice
buddy_create_entity(
  "Redis",
  "technology",
  ["Used for session storage", "Also handles rate limiting", "Cluster mode enabled"],
  ["cache", "infrastructure"]
)
```

### buddy_search_entities(query, [limit])

Search for entities.

**Examples:**

```
# Search for authentication-related entities
buddy_search_entities("authentication")

# Search with limit
buddy_search_entities("user", 5)
```

### buddy_create_relation(from, to, type, [description])

Create a relationship between entities.

**Arguments:**

- `from` (string, required): Source entity
- `to` (string, required): Target entity
- `type` (string, required): Relation type
- `description` (string, optional): Description

**Relation types:** depends_on, implements, related_to, caused_by, fixed_by, uses, extends

**Examples:**

```
# Create dependencies
buddy_create_relation("JWT Authentication", "UserService", "depends_on")
buddy_create_relation("UserController", "UserService", "uses")
buddy_create_relation("AdminUserService", "UserService", "extends")

# Record bug fix relationships
buddy_create_relation("Auth Token Expiry Fix", "Session Timeout Bug", "fixed_by")
```

---

## Error Learning

Record and learn from AI mistakes to prevent repetition.

### buddy_record_mistake(action, errorType, userCorrection, correctMethod, impact, preventionMethod, [relatedRule])

Record an AI mistake.

**Arguments:**

- `action` (string): What the AI did wrong
- `errorType` (string): Type of error
- `userCorrection` (string): What the user corrected
- `correctMethod` (string): The right approach
- `impact` (string): Impact of the error
- `preventionMethod` (string): How to prevent it
- `relatedRule` (string, optional): Related rule

**Error types:**

- `procedure-violation`: Violated a procedure
- `workflow-skip`: Skipped a workflow step
- `assumption-error`: Made a wrong assumption
- `validation-skip`: Skipped validation
- `responsibility-lack`: Lacked ownership
- `firefighting`: Fixed symptoms, not root cause
- `dependency-miss`: Missed a dependency
- `integration-error`: Integration mistake
- `deployment-error`: Deployment mistake

**Example:**

```
buddy_record_mistake(
  "Edited file without reading it first",
  "procedure-violation",
  "Always read the file before editing to understand context",
  "Use view_file before any edit operations",
  "Accidentally overwrote important code",
  "Always read file content before making changes",
  "Rule: Read before write"
)
```

### buddy_get_mistake_patterns()

Get error pattern analysis.

**Example:**

```
buddy_get_mistake_patterns()

# Returns:
# - Error counts by type
# - Recent errors
# - Prevention rules
```

---

## Workflow Guidance

Get development phase guidance and recommendations.

### buddy_get_workflow_guidance(phase, [filesChanged], [testsPassing], [hasLintErrors])

Get workflow guidance for current phase.

**Arguments:**

- `phase` (string, required): Current phase
- `filesChanged` (string[], optional): Changed files
- `testsPassing` (boolean, optional): Tests status
- `hasLintErrors` (boolean, optional): Lint status

**Phases:**

- `idle`: Not actively working
- `planning`: Planning the work
- `implementing`: Writing code
- `code-written`: Code complete
- `testing`: Running tests
- `test-complete`: Tests done
- `reviewing`: Code review
- `commit-ready`: Ready to commit
- `committed`: Changes committed
- `deploying`: Deploying
- `completed`: Work complete

**Examples:**

```
# Get guidance for implementation phase
buddy_get_workflow_guidance("implementing")

# Get guidance with context
buddy_get_workflow_guidance(
  "code-written",
  ["src/auth/login.ts", "src/auth/types.ts"],
  true,
  false
)
```

### buddy_get_session_health()

Check current work session health.

**Example:**

```
buddy_get_session_health()

# Returns:
# - Session duration
# - Tasks completed
# - Memories created
# - Productivity score
# - Warnings and suggestions
```

---

## AI Integration

Optionally connect to vLLM or other OpenAI-compatible APIs.

### buddy_configure_ai(baseUrl, model, [apiKey], [enabled])

Configure AI connection.

**Arguments:**

- `baseUrl` (string, required): API base URL
- `model` (string, required): Model name
- `apiKey` (string, optional): API key
- `enabled` (boolean, optional): Enable (default: true)

**Examples:**

```
# Connect to local vLLM
buddy_configure_ai("http://localhost:8000/v1", "qwen2.5-coder-7b")

# Connect to Ollama
buddy_configure_ai("http://localhost:11434/v1", "codellama")

# Connect with API key
buddy_configure_ai("https://api.example.com/v1", "gpt-4", "sk-xxx", true)
```

### buddy_test_ai_connection()

Test the AI connection.

**Example:**

```
buddy_test_ai_connection()

# Returns connection status and available models
```

### buddy_get_ai_status()

Get AI configuration status.

**Example:**

```
buddy_get_ai_status()

# Shows current configuration
```

---

## Best Practices

### 1. Start Every Task with buddy_do

```
# Good practice
buddy_do("Implement password reset flow")
# Then proceed with implementation

# Bad practice
# Start coding without recording
```

### 2. Record Important Decisions

```
# When you make a significant choice
buddy_add_memory(
  "Chose Redis over Memcached",
  "Redis offers persistence, pub/sub, and data structures we need",
  "decision",
  ["cache", "infrastructure"]
)
```

### 3. Use Knowledge Graph for Architecture

```
# Create entities for components
buddy_create_entity("AuthModule", "component", ["Handles all auth", "Uses JWT"], ["auth"])
buddy_create_entity("UserModule", "component", ["User management"], ["user"])

# Create relationships
buddy_create_relation("AuthModule", "UserModule", "depends_on")
```

### 4. Learn from Mistakes

```
# When AI makes an error, record it
buddy_record_mistake(...)

# Periodically review patterns
buddy_get_mistake_patterns()
```

### 5. Check Session Health

```
# Check your work session periodically
buddy_get_session_health()
```

---

## Hook System

Code Buddy 使用 OpenCode 的原生 Hook 系統，在特定事件發生時自動執行動作。

### 可用的 Hooks

| Hook                | 預設  | 事件                                  | 功能              |
| ------------------- | ----- | ------------------------------------- | ----------------- |
| `autoRemind`        | ✅ 開 | `session.idle`                        | AI 完成時提醒記錄 |
| `protectEnv`        | ✅ 開 | `tool.execute.before`                 | 阻止敏感檔案存取  |
| `trackFiles`        | ❌ 關 | `file.edited`                         | 自動追蹤檔案編輯  |
| `compactionContext` | ✅ 開 | `session.compacting`                  | 壓縮時注入記憶    |
| `autoObserve`       | ✅ 開 | `tool.execute.after` + `session.idle` | 🆕 背景觀察者     |

---

### autoObserve (Background Observer) 🆕

**用途**: 像旁觀者一樣自動觀察 AI 的工具使用行為，並在 AI 閒置時自動摘要儲存。

**工作流程**:

```
AI 使用工具 → tool.execute.after 攔截 → 累積到 observationBuffer
                                            ↓
                                    session.idle 觸發
                                            ↓
                               AI 自動產生摘要 + tags
                                            ↓
                                  addMemoryWithDedup()
```

**自動記錄範例**:

```
🔍 Observer: ✅ Memory created: "Implemented JWT auth endpoint" (from 8 observations)
   Type: feature
   Tags: [jwt, authentication, api, express, auto-observed]
```

**設定選項**:

```json
{
  "hooks": {
    "autoObserve": true,
    "observeMinActions": 3,
    "observeIgnoreTools": ["buddy_remember", "buddy_help"]
  }
}
```

| 選項                 | 說明                                 |
| -------------------- | ------------------------------------ |
| `autoObserve`        | 啟用/停用背景觀察                    |
| `observeMinActions`  | 最少幾次工具使用才觸發摘要 (預設: 3) |
| `observeIgnoreTools` | 忽略的工具列表 (buddy\_\* 自動忽略)  |

**Fallback**: 無 LLM 時使用 rule-based 摘要 (列出使用的工具名稱)

---

### AI Auto-Tag 🆕

**用途**: 使用 `buddy_add_memory` 時若未提供 tags，AI 自動根據標題和內容產生 3-5 個相關 tag。

**範例**:

```
# 不需要手動填 tags，AI 會自動產生
buddy_add_memory(
  title: "Use Redis for session caching",
  content: "Chose Redis for low-latency...",
  type: "decision"
)
# AI 自動產生 tags: ["redis", "session", "caching", "infrastructure"]
```

---

### autoRemind (session.idle)

**用途**: 當 AI 完成回應後，提醒使用者記錄任務結果。

**觸發時機**: 每次 AI 回應結束時

**行為**:

```
[code-buddy] 💡 Reminder: 3 task(s) completed. Use buddy_done to record results.
```

**使用場景**:

- 防止忘記記錄重要的任務結果
- 維持專案記憶的完整性

---

### protectEnv (tool.execute.before)

**用途**: 阻止任何工具讀取敏感設定檔。

**保護的檔案模式**:

- `.env`
- `.env.local`
- `.env.production`
- 包含 `secrets` 的路徑

**觸發時機**: 任何工具執行前

**行為**:

```
[code-buddy] ⚠️ Protected file access blocked: .env
Error: [Code Buddy] Access to protected file ".env" is blocked.
```

**使用場景**:

- 保護 API 金鑰不被意外讀取
- 防止敏感資訊洩漏到 AI 模型

**停用方式**:

```json
{
  "hooks": {
    "protectEnv": false
  }
}
```

---

### trackFiles (file.edited)

**用途**: 自動記錄專案中被編輯的檔案。

**預設狀態**: 關閉 (可能產生大量記憶)

**忽略的路徑**:

- `node_modules/`
- `.git/`
- `dist/`
- `build/`
- `.next/`
- `package-lock.json`

**觸發時機**: 每次檔案被編輯時

**行為**:

```
[code-buddy] 📝 Tracked file edit: src/components/Login.tsx
```

**記憶格式**:

```
Type: feature (knowledge)
Title: File edited: Login.tsx
Content: Edited file: src/components/Login.tsx
Tags: auto-tracked, file-edit
```

**啟用方式**:

```json
{
  "hooks": {
    "trackFiles": true
  }
}
```

---

### compactionContext (session.compacting)

**用途**: 當 Session 太長需要壓縮時，保留最近的記憶作為上下文。

**觸發時機**: OpenCode 執行 session compaction 時

**行為**:
在壓縮 prompt 中注入:

```markdown
## Code Buddy Memory Context

Recent project memories that should persist:

- [feature] Task: Implement login...
- [decision] Use JWT for auth
- [bugfix] Fix null pointer...

Use `buddy_remember` to recall more details if needed.
```

**效果**:

- 即使對話被壓縮，重要的專案記憶仍會保留
- AI 可以繼續參考之前的決策和任務

---

### Hook 設定

所有 Hook 設定都在 `.opencode/code-buddy/config.json`:

```json
{
  "hooks": {
    "autoRemind": true,
    "protectEnv": true,
    "trackFiles": false,
    "compactionContext": true
  }
}
```

### 驗證 Hooks 是否運作

1. **autoRemind**: 執行任務後觀察 console 輸出
2. **protectEnv**: 嘗試讓 AI 讀取 `.env` 檔案
3. **trackFiles**: 啟用後編輯檔案，檢查 `buddy_remember_recent()`
4. **compactionContext**: 長對話後檢查壓縮的 context

---

## Troubleshooting

### Plugin Not Loading

1. Verify the plugin directory exists:

   ```bash
   ls ~/.config/opencode/plugins/code-buddy/
   ```

2. Check dependencies are installed:

   ```bash
   cd ~/.config/opencode/plugins/code-buddy
   npm install
   ```

3. Restart OpenCode

### Commands Not Found

Verify the plugin initialized:

```
buddy_help()
```

If you see an error, check the console for initialization errors.

### Data Not Persisting

Check if the data directory is writable:

```bash
ls -la .opencode/code-buddy/data/
```

### AI Connection Failed

1. Verify the AI service is running:

   ```bash
   curl http://localhost:8000/v1/models
   ```

2. Check configuration:

   ```
   buddy_get_ai_status()
   ```

3. Test connection:
   ```
   buddy_test_ai_connection()
   ```

---

## Support

For issues or feature requests, please refer to the project documentation.

💡 **Remember**: Use `buddy_help("command_name")` for detailed help on any command!
