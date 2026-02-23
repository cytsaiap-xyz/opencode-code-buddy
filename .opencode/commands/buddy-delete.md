---
description: "🗑️ Delete memories (with confirmation)"
---

Use the `buddy_delete_memory` tool to delete memories.

## Two-Step Confirmation

**Step 1**: Find memories to delete

```
buddy_delete_memory(query: "search term")
buddy_delete_memory(id: "memory_id")
buddy_delete_memory(type: "decision")
```

**Step 2**: Confirm with the code provided

```
buddy_delete_memory(confirmCode: "ABC123")
```

⚠️ **WARNING**: Deletion cannot be undone!

Example: $ARGUMENTS
