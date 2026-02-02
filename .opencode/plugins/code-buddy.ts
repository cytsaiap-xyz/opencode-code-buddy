/**
 * OpenCode Code Buddy Plugin - Single File Version
 * Simplified for direct loading
 */

import { tool } from "@opencode-ai/plugin";

// Simple in-memory storage
const memory = [];
const entities = [];

export const CodeBuddyPlugin = async (ctx) => {
    const { directory } = ctx;

    console.log("[code-buddy] Plugin initialized - directory:", directory);

    return {
        tool: {
            buddy_help: tool({
                description: "Display help for all buddy commands",
                args: {},
                async execute() {
                    return `# 🤖 Code Buddy Help

## Available Commands

### 🎯 Core Commands
- \`buddy_do(task)\` - Execute and analyze a development task
- \`buddy_help()\` - Display this help

### 🧠 Memory Commands  
- \`buddy_remember(query)\` - Search project memories
- \`buddy_add_memory(title, content, type)\` - Add a memory

### 📊 Status Commands
- \`buddy_status()\` - Show plugin status

---
📴 All features work **offline**.`;
                }
            }),

            buddy_do: tool({
                description: "Execute a development task with automatic analysis and recording",
                args: {
                    task: tool.schema.string().describe("Task description")
                },
                async execute(args) {
                    const entry = {
                        id: `task_${Date.now()}`,
                        task: args.task,
                        timestamp: Date.now(),
                        type: detectTaskType(args.task)
                    };
                    memory.push(entry);

                    return `## 🎯 Task Recorded

**Task**: ${args.task}
**ID**: ${entry.id}
**Type**: ${entry.type}
**Time**: ${new Date().toLocaleString()}

### 📋 Suggested Steps
1. Understand requirements
2. Design solution
3. Implement
4. Test
5. Review

💾 Task saved to memory.`;
                }
            }),

            buddy_remember: tool({
                description: "Search project memories",
                args: {
                    query: tool.schema.string().describe("Search query")
                },
                async execute(args) {
                    const results = memory.filter(m =>
                        m.task && m.task.toLowerCase().includes(args.query.toLowerCase())
                    );

                    if (results.length === 0) {
                        return `🔍 No memories found for "${args.query}"`;
                    }

                    let msg = `## 🔍 Search Results for "${args.query}"\n\n`;
                    for (const r of results) {
                        msg += `- **${r.task}** (${r.type}) - ${new Date(r.timestamp).toLocaleDateString()}\n`;
                    }
                    return msg;
                }
            }),

            buddy_add_memory: tool({
                description: "Add a memory entry",
                args: {
                    title: tool.schema.string().describe("Memory title"),
                    content: tool.schema.string().describe("Memory content"),
                    type: tool.schema.string().describe("Type: decision, pattern, bugfix, lesson, feature, note")
                },
                async execute(args) {
                    const entry = {
                        id: `mem_${Date.now()}`,
                        title: args.title,
                        content: args.content,
                        type: args.type,
                        timestamp: Date.now()
                    };
                    memory.push(entry);

                    return `✅ Memory added: ${args.title}`;
                }
            }),

            buddy_status: tool({
                description: "Show plugin status",
                args: {},
                async execute() {
                    return `## 📊 Code Buddy Status

**Memories**: ${memory.length}
**Entities**: ${entities.length}
**Directory**: ${directory}
**Status**: ✅ Running

Use \`buddy_help()\` for command list.`;
                }
            })
        }
    };
};

function detectTaskType(task) {
    const lower = task.toLowerCase();
    if (/implement|build|create|add|feature/.test(lower)) return "implement";
    if (/fix|bug|error|issue/.test(lower)) return "fix";
    if (/refactor|improve|optimize/.test(lower)) return "refactor";
    if (/test|spec/.test(lower)) return "test";
    if (/doc|readme/.test(lower)) return "document";
    return "task";
}

export default CodeBuddyPlugin;
