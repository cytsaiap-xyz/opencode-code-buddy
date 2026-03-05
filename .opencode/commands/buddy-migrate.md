---
description: "🔄 Migrate storage format between JSON and markdown"
---

Use the `buddy_migrate_storage` tool to migrate between storage formats.

Target formats:
- `markdown` - Human-readable markdown files with YAML frontmatter
- `json` - Legacy JSON file storage

First run without `confirm` to preview, then with `confirm: true` to execute.

Example: buddy_migrate_storage(target: "$ARGUMENTS", confirm: false)
