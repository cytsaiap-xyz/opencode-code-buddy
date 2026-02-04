---
description: "🎯 Analyze a development task and record to memory"
---

Use the `buddy_do` tool to analyze this task: $ARGUMENTS

## Features

| Feature             | Description                              |
| ------------------- | ---------------------------------------- |
| **Task Analysis**   | Identifies type and complexity           |
| **Step Suggestion** | Provides recommended execution steps     |
| **Auto-Recording**  | Saves to memory with deduplication       |
| **AI Execution**    | Optional - set `execute: true` to use AI |

## Parameters

| Parameter | Default  | Description                  |
| --------- | -------- | ---------------------------- |
| `task`    | required | Task description             |
| `execute` | false    | Set true to execute using AI |
| `context` | optional | Code or additional context   |

## Example

```
buddy_do("Implement user login")
buddy_do("Fix null pointer", execute: true)
buddy_do("Research caching", context: "Redis vs Memcached")
```

## Workflow

```
buddy_do("task")  →  Execute  →  buddy_done("task", "result")
```
