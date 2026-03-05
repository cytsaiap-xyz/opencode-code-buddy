# Design: Hybrid Markdown + YAML Memory Storage

## Motivation

Code-Buddy currently stores all memory in JSON files (`memory.json`, `entities.json`, `relations.json`, `mistakes.json`). This is machine-friendly but painful for humans to read, edit, or review in PRs.

Claude Code Memory uses plain markdown (`CLAUDE.md`) — great for humans, but lacks structure for querying, typing, or relational modeling.

This proposal combines both: **markdown files for human-facing content, structured YAML for machine-facing metadata**.

---

## Directory Structure

```
.opencode/code-buddy/data/
├── entries/                          # One markdown file per memory entry
│   ├── 2026-03-05-fix-auth-timeout.md
│   ├── 2026-03-05-add-rate-limiting.md
│   ├── 2026-03-04-use-connection-pool.md
│   └── ...
├── mistakes/                         # One markdown file per mistake record
│   ├── 2026-03-05-wrong-env-variable.md
│   └── ...
├── graph.yaml                        # Knowledge graph (entities + relations)
├── index.yaml                        # Auto-generated entry index for fast queries
└── config.json                       # Plugin config (unchanged)
```

### Why this layout

| Concern | File | Rationale |
|---|---|---|
| Human reads/edits a memory | `entries/*.md` | One file = one thought. Easy to open, edit, delete. |
| Human reads/edits a mistake | `mistakes/*.md` | Same principle, separate directory to avoid clutter. |
| Machine queries by type/tag/date | `index.yaml` | Pre-computed index, no need to parse all files. |
| Architecture relationships | `graph.yaml` | Graph data is inherently relational; one file keeps it coherent. |
| PR review | `entries/*.md` diffs | Markdown diffs are clean and reviewable. |
| Git blame | Per-file | Each entry has its own history. |

---

## File Formats

### 1. Memory Entry (`entries/*.md`)

```markdown
---
id: mem_a1b2c3
type: bugfix                    # decision | pattern | bugfix | lesson | feature | note
category: solution              # solution | knowledge (auto-derived from type)
tags: [auth, jwt, timeout]
entities: [AuthService]         # Links to graph.yaml entities (optional)
date: 2026-03-05
source: auto                    # auto | manual | import
---

## Fix auth timeout under load

**Root cause:** Token refresh had a race condition — when multiple requests
hit the auth endpoint simultaneously, expired tokens weren't refreshed
before the next request used them.

**Fix:** Increased JWT expiry from 1h to 24h and added a 5-minute buffer
before the expiry check triggers a refresh.

**Prevention:** Always add buffer time to token expiry checks. Never rely
on exact expiry timestamps in distributed systems.
```

#### Filename Convention

```
{date}-{slug}.md
```

- `date`: `YYYY-MM-DD` for chronological sorting via `ls`
- `slug`: kebab-case, derived from title, max 50 chars
- Examples: `2026-03-05-fix-auth-timeout.md`, `2026-03-04-use-connection-pool.md`

#### Frontmatter Schema

```yaml
# Required
id: string            # Unique ID (mem_{nanoid})
type: MemoryType      # decision | pattern | bugfix | lesson | feature | note
tags: string[]        # Searchable tags

# Auto-derived
category: MemoryCategory  # solution | knowledge

# Optional
entities: string[]    # References to entity names in graph.yaml
date: string          # YYYY-MM-DD
source: string        # auto | manual | import
supersedes: string    # ID of entry this replaces (for dedup merges)
```

#### Content Body Guidelines

The markdown body is **free-form** but encouraged to follow patterns per type:

| Type | Suggested Sections |
|---|---|
| `bugfix` | Root cause, Fix, Prevention |
| `decision` | Context, Decision, Rationale, Alternatives considered |
| `pattern` | When to use, Implementation, Example |
| `lesson` | What happened, What I learned, Apply when |
| `feature` | What it does, How it works, Key files |
| `note` | (free-form) |

These are guidelines, not enforced schema. Humans can write whatever they want.

---

### 2. Mistake Record (`mistakes/*.md`)

```markdown
---
id: err_x1y2z3
errorType: assumption-error     # procedure-violation | workflow-skip | assumption-error | ...
severity: medium                # low | medium | high | critical
tags: [env, configuration]
relatedEntry: mem_a1b2c3        # Links to a memory entry (optional)
relatedEntity: ConfigService    # Links to graph.yaml entity (optional)
date: 2026-03-05
---

## Used wrong environment variable for database URL

**Action taken:** Set `DB_URL` in production config.

**What went wrong:** The app reads `DATABASE_URL`, not `DB_URL`.
No error at startup — it silently fell back to the default SQLite database.

**Correct method:** Check `.env.example` for canonical variable names
before setting production config.

**Impact:** 2 hours of debugging why production data wasn't persisting.

**Prevention:** Always verify env var names against `.env.example` or
the config loader source code before deployment.
```

#### Frontmatter Schema

```yaml
# Required
id: string            # Unique ID (err_{nanoid})
errorType: ErrorType  # procedure-violation | workflow-skip | assumption-error | ...
date: string          # YYYY-MM-DD

# Optional
severity: string      # low | medium | high | critical
tags: string[]
relatedEntry: string  # Memory entry ID
relatedEntity: string # Entity name from graph.yaml
```

---

### 3. Knowledge Graph (`graph.yaml`)

Single file — tooling manages it, humans occasionally review it.

```yaml
# Knowledge Graph — managed by Code-Buddy tooling
# Manual edits are fine but use the tools when possible.

entities:
  AuthService:
    type: component           # decision | feature | component | file | bug_fix | lesson | pattern | technology
    tags: [auth, security]
    observations:
      - "Handles JWT token generation and validation"
      - "Uses RS256 signing algorithm"
      - "Added refresh token support on 2026-03-04"
    created: 2026-03-01

  UserModel:
    type: component
    tags: [database, user]
    observations:
      - "Sequelize model with soft deletes"
    created: 2026-03-01

  Express:
    type: technology
    tags: [framework, http]
    observations:
      - "v4.18, planning migration to v5"
    created: 2026-03-01

relations:
  - from: AuthService
    to: UserModel
    type: depends_on           # depends_on | implements | related_to | caused_by | fixed_by | uses | extends
    description: "Queries user records for login validation"

  - from: AuthService
    to: Express
    type: uses
    description: "Mounted as Express middleware"
```

#### Why a single file for the graph

- **Entities are small** — a name, type, and a few observations. Not worth one file each.
- **Relations need context** — seeing `AuthService → depends_on → UserModel` next to `AuthService → uses → Express` in one place makes the architecture scannable.
- **Rarely hand-edited** — most edits go through `buddy_create_entity` / `buddy_create_relation`. The YAML format is a readable fallback, not the primary editing interface.
- **Atomic consistency** — entities and relations must be consistent (no dangling references). One file makes validation simple.

---

### 4. Entry Index (`index.yaml`)

Auto-generated. Rebuilt on startup and after every write. Humans should not edit this file.

```yaml
# Auto-generated — do not edit manually
# Rebuilt by Code-Buddy on startup and after writes

generated: 2026-03-05T10:30:00Z
count: 42

byType:
  bugfix: [mem_a1b2c3, mem_d4e5f6]
  decision: [mem_g7h8i9]
  pattern: [mem_j0k1l2, mem_m3n4o5]
  lesson: [mem_p6q7r8]
  feature: [mem_s9t0u1]
  note: [mem_v2w3x4]

byTag:
  auth: [mem_a1b2c3, mem_g7h8i9]
  jwt: [mem_a1b2c3]
  database: [mem_d4e5f6]
  performance: [mem_j0k1l2]

entries:
  mem_a1b2c3:
    file: "2026-03-05-fix-auth-timeout.md"
    type: bugfix
    category: solution
    tags: [auth, jwt, timeout]
    title: "Fix auth timeout under load"     # First heading from body
    date: 2026-03-05
```

#### Why an index file

| Without index | With index |
|---|---|
| Query "all bugfixes" → read + parse every `.md` file | Query "all bugfixes" → read `index.yaml`, get file list |
| 100 entries → 100 file reads on startup | 100 entries → 1 file read on startup |
| Tag search → scan all frontmatter | Tag search → lookup `byTag` map |

The index is a **read cache**, not source of truth. If it's missing or corrupt, rebuild from `entries/*.md` files.

---

## Operations Mapping

How current Code-Buddy operations map to the new storage:

| Operation | Current (JSON) | New (Markdown + YAML) |
|---|---|---|
| Add memory | Append to `memory.json` array | Write `entries/{date}-{slug}.md` + update `index.yaml` |
| Search memory | Filter JSON array in memory | Read `index.yaml` → filter by type/tag → read matching `.md` files |
| Delete memory | Remove from `memory.json` array | Delete `.md` file + update `index.yaml` |
| Dedup check | Compare against JSON array | Read `index.yaml` for candidates → read `.md` frontmatter + content |
| Guide injection | Filter JSON by type + similarity | Read `index.yaml` byType → read matching `.md` → similarity score |
| Create entity | Append to `entities.json` | Add entry under `graph.yaml` entities |
| Create relation | Append to `relations.json` | Add entry under `graph.yaml` relations |
| Record mistake | Append to `mistakes.json` | Write `mistakes/{date}-{slug}.md` |
| Session compaction | Inject from JSON arrays | Read `index.yaml` → read relevant `.md` → inject |

---

## Migration Path

### Phase 1: Read/Write layer (non-breaking)

1. Add `MarkdownStorage` class alongside existing `LocalStorage`
2. `MarkdownStorage` reads/writes `.md` files + `index.yaml` + `graph.yaml`
3. Config flag: `storage.format: "json" | "markdown"` (default: `"json"`)
4. All tool functions call storage through an interface — swap implementation based on config

### Phase 2: Migration command

```
/buddy-migrate-storage
```

- Reads all existing JSON files
- Converts each `MemoryEntry` → `entries/*.md`
- Converts each `MistakeRecord` → `mistakes/*.md`
- Converts `entities.json` + `relations.json` → `graph.yaml`
- Builds `index.yaml`
- Sets `storage.format: "markdown"` in config
- Keeps JSON files as backup (suffixed `.backup.json`)

### Phase 3: Remove JSON support

- After sufficient adoption, remove `LocalStorage` JSON backend
- `MarkdownStorage` becomes the only implementation

---

## Edge Cases & Considerations

### Filename collisions
Two entries on the same date with the same slug → append counter: `2026-03-05-fix-auth-timeout-2.md`

### Concurrent writes
Same risk as current JSON approach. Mitigation: file-level locking per write, or accept last-write-wins (acceptable for single-user local tool).

### Large projects (1000+ entries)
- `index.yaml` keeps queries fast without scanning all files
- Consider archiving old entries to `entries/archive/2025/` by year
- Index rebuild is O(n) but only happens on startup

### Frontmatter parsing
Use a lightweight YAML frontmatter parser (e.g., `gray-matter` npm package). Don't hand-roll regex parsing — YAML edge cases are numerous.

### Git-friendliness
- One file per entry = one-line diff per change in `git log --stat`
- `graph.yaml` changes show clear entity/relation additions
- `index.yaml` is noisy in diffs → add to `.gitignore` (it's a cache, regenerable)

---

## Summary

| Property | Current (JSON) | Proposed (Markdown + YAML) |
|---|---|---|
| Human readability | Poor | Excellent |
| Human editability | Requires tooling | Any text editor |
| PR reviewability | Noisy JSON diffs | Clean markdown diffs |
| Machine queryability | Direct array access | Index-based lookup |
| Startup performance | Read 4 JSON files | Read 2 YAML files (index + graph) |
| Storage overhead | Compact | Slightly larger (frontmatter + filenames) |
| Git blame granularity | Per-array (useless) | Per-file (useful) |
| Team shareable | Technically yes, practically no | Yes — designed for it |
| Complexity | Simple read/write | Moderate (index maintenance, frontmatter parsing) |
