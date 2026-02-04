---
description: "🎯 Execute a development task with AI assistance"
---

Use the `buddy_do` tool to execute this task: $ARGUMENTS

## Features

| Feature                  | Description                                           |
| ------------------------ | ----------------------------------------------------- |
| **AI Execution**         | Provides analysis, solution, and next steps           |
| **Auto-Recording**       | Saves to memory with deduplication                    |
| **Smart Type Detection** | Identifies task type (implement, fix, refactor, etc.) |

## Parameters

| Parameter | Default  | Description                |
| --------- | -------- | -------------------------- |
| `task`    | required | Task description           |
| `execute` | true     | Execute using AI           |
| `context` | optional | Code or additional context |

## Example

```
buddy_do("Implement user login with JWT")
buddy_do("Fix the null pointer exception", context: "function foo() { ... }")
buddy_do("Research best practices for API rate limiting", execute: false)
```
