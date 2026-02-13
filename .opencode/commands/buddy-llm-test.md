---
description: "🔌 Test LLM provider connectivity and list available providers"
---

Use the `buddy_llm_test` tool to test your LLM provider connectivity.

This will:

- List all providers configured in `opencode.json`
- Test API connectivity with a ping request
- Report latency and response status
- Show the currently active provider

To test a specific provider:

```
buddy_llm_test({ provider: "nvidia" })
```
