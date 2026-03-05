# Claude Code Memory vs Code-Buddy: Comparison

## Overview

| Aspect | Claude Code Memory | Code-Buddy (OpenCode Plugin) |
|---|---|---|
| **Platform** | Claude Code (Anthropic CLI) | OpenCode AI editor plugin |
| **Storage Format** | Markdown files (`CLAUDE.md`, `MEMORY.md`) | JSON files (`memory.json`, `entities.json`, etc.) |
| **Architecture** | File-tree convention + auto-notes | Plugin with 21 tools, hooks, knowledge graph |

---

## Claude Code Memory — Pros & Cons

### Pros

1. **Dead simple** — just create a `CLAUDE.md` markdown file; no plugin installation needed
2. **Hierarchical scoping** — project, user, org, local, and subdirectory levels with clear precedence rules
3. **Team-friendly** — `CLAUDE.md` checks into git, so the whole team shares project instructions
4. **Import system** — `@path/to/file` syntax lets you modularly compose instructions from other files
5. **Path-specific rules** — `.claude/rules/*.md` with glob frontmatter only load when working on matching files, saving context
6. **Auto memory** — Claude self-writes notes to `~/.claude/projects/<project>/memory/` without manual effort
7. **Survives compaction** — `CLAUDE.md` is re-read from disk after `/compact`, so instructions never get lost
8. **Enterprise support** — managed policy location (`/etc/claude-code/CLAUDE.md`) for org-wide standards
9. **Zero dependencies** — no external APIs, databases, or plugins; pure file convention
10. **`/init` command** — auto-generates a starter `CLAUDE.md` by analyzing the codebase

### Cons

1. **Flat structure** — memory is just markdown text; no typed categories (decision vs. bugfix vs. pattern)
2. **No knowledge graph** — no entity/relation modeling; can't query "what depends on what"
3. **No error learning** — no structured mistake recording or pattern analysis
4. **200-line limit** — only first 200 lines of `MEMORY.md` load at startup; longer content requires manual topic splitting
5. **No deduplication** — auto memory can accumulate redundant notes; user must manually prune
6. **No smart search** — no similarity matching or semantic search; relies on Claude's own judgment to find relevant notes
7. **No workflow tracking** — no concept of development phases (planning → implementing → testing → deploying)
8. **No automatic observation** — auto memory saves when Claude *decides* to, not via structured tool-execution hooks
9. **Context-only, not enforced** — Claude *tries* to follow `CLAUDE.md` but compliance is not guaranteed
10. **Single-agent focus** — no built-in multi-agent session isolation or delegation context

---

## Code-Buddy — Pros & Cons

### Pros

1. **Typed memory** — 6 semantic types (decision, pattern, bugfix, lesson, feature, note) in 2 categories (solution vs. knowledge)
2. **Knowledge graph** — entities + 7 relation types (depends_on, implements, caused_by, etc.) for structured project modeling
3. **Error learning** — structured mistake records with 10 error types, prevention methods, and aggregate pattern analysis
4. **Auto-observer** — hooks into every tool execution; automatically buffers, classifies, and saves memories without manual effort
5. **Two-layer deduplication** — Jaccard similarity (sync) + LLM semantic matching (async) prevents memory bloat
6. **Guide injection** — proactively injects relevant past memories into your prompt using overlap-coefficient similarity
7. **Workflow tracking** — development phase awareness (idle → planning → implementing → testing → deploying) with recommendations
8. **Session health monitoring** — tracks tasks completed, memories created, errors recorded per session
9. **21 tools + 19 slash commands** — rich CLI interface for querying, adding, analyzing, and managing memories
10. **Optional LLM integration** — auto-tagging, semantic dedup, and AI-powered suggestions via OpenAI-compatible APIs
11. **Multi-agent support** — isolated observation buffers per session/subagent with delegation context

### Cons

1. **Complex setup** — requires plugin installation, configuration, and `.opencode/` directory structure
2. **OpenCode-only** — tightly coupled to the OpenCode editor; not portable to other AI coding tools
3. **No team sharing** — memory is local JSON files; no built-in mechanism to share memories via source control
4. **No hierarchical scoping** — no equivalent of user-level vs. project-level vs. org-level instructions
5. **No path-specific rules** — cannot scope instructions to specific file patterns like `.claude/rules/` frontmatter
6. **Heavy footprint** — 4,500+ lines of code, multiple JSON files, hook system, LLM integration for what is essentially a memory store
7. **JSON fragility** — concurrent writes or corruption in JSON files could lose data (no WAL or atomic writes)
8. **Noise risk** — auto-observer fires on every tool execution; can generate low-value memories even with the 3-action buffer threshold
9. **No import/composition system** — cannot compose instructions from external files or link shared rule sets across projects

---

## Summary: When to Use Which

| Scenario | Better Choice |
|---|---|
| Quick project setup with persistent instructions | **Claude Code Memory** — just write a `CLAUDE.md` |
| Team-shared coding standards | **Claude Code Memory** — `CLAUDE.md` goes into git |
| Structured decision/error tracking | **Code-Buddy** — typed memories + mistake records |
| Understanding project architecture relationships | **Code-Buddy** — knowledge graph with entities & relations |
| Enterprise/org-wide policies | **Claude Code Memory** — managed policy support |
| Fully automatic memory accumulation | **Code-Buddy** — auto-observer with dedup is more systematic |
| Minimal overhead / simplicity | **Claude Code Memory** — zero setup, just markdown |
| Multi-agent workflows | **Code-Buddy** — session isolation + delegation context |

---

## Bottom Line

Claude Code Memory wins on **simplicity, team collaboration, and scoping flexibility**. Code-Buddy wins on **structured knowledge management, automatic observation, and error learning**. They solve overlapping but distinct problems — Claude Code Memory is a lightweight convention for persistent instructions, while Code-Buddy is a full-featured knowledge management system for AI-assisted development.
