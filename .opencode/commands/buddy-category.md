---
description: "📂 Filter memories by category (solution/knowledge)"
---

Use `buddy_remember_by_category` to filter memories by category.

## Categories

| Category      | Types                    | Description              |
| ------------- | ------------------------ | ------------------------ |
| **solution**  | decision, bugfix, lesson | Problem-solving memories |
| **knowledge** | pattern, feature, note   | Knowledge accumulation   |

## Usage

```
# Get solution memories
buddy_remember_by_category("solution")

# Get knowledge memories with search
buddy_remember_by_category("knowledge", query: "JWT")

# Limit results
buddy_remember_by_category("solution", limit: 5)
```

Example: $ARGUMENTS
