---
description: "✅ Record a completed task with results and learnings"
---

Use the `buddy_done` tool to record this completed task: $ARGUMENTS

## Parameters

| Parameter   | Required | Description                    |
| ----------- | -------- | ------------------------------ |
| `task`      | ✓        | What task was completed        |
| `result`    | ✓        | The outcome/result             |
| `learnings` | optional | Key learnings from this task   |
| `type`      | optional | Memory type (default: feature) |

## Examples

```
# Basic completion
buddy_done("Implement login", "Added JWT-based authentication")

# With learnings
buddy_done("Fix null pointer", "Added null check", learnings: "Always validate before access")

# As lesson type
buddy_done("Resolve race condition", "Used mutex lock", type: "lesson")
```

## Workflow

```
buddy_do("task")  →  Execute  →  buddy_done("task", "result")
```
