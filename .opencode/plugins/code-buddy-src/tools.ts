/**
 * All 21 tool definitions for Code Buddy.
 */

import { tool } from "@opencode-ai/plugin";
import type {
    MemoryType, MemoryCategory, MemoryEntry,
    EntityType, Entity, Relation, ErrorType, MistakeRecord,
} from "./types";
import { MEMORY_TYPE_CATEGORY, VALID_MEMORY_TYPES } from "./types";
import { saveConfig } from "./config";
import {
    generateId, generateConfirmCode, searchText,
    getMemoryCategory, detectTaskType, estimateComplexity,
    TASK_STEPS, WORKFLOW_STEPS, WORKFLOW_PROGRESS,
} from "./helpers";
import {
    resolveProvider, getLLMStatus, askAI,
    addMemoryWithDedup, autoGenerateTags,
} from "./llm";
import type { PluginState } from "./state";

// ============================================
// Factory — returns an object of all tools
// ============================================

export function createTools(s: PluginState) {
    return {

        // ========================================
        // CONFIG
        // ========================================

        buddy_config: tool({
            description: "View or update LLM provider configuration",
            args: {
                action: tool.schema.string().optional().describe("Action: view, set_provider, set_model"),
                value: tool.schema.string().optional().describe("Value for the setting"),
            },
            async execute(args) {
                const action = args.action || "view";

                if (action === "view") {
                    const provider = await resolveProvider(s);
                    const status = await getLLMStatus(s);

                    let providerInfo = "No provider resolved";
                    if (provider) {
                        providerInfo = [
                            `| Provider | ${provider.name} (${provider.providerID}) |`,
                            `| Model | ${provider.modelID} |`,
                            `| Base URL | ${provider.baseURL} |`,
                            `| API Key | ***configured*** |`,
                        ].join("\n");
                    }

                    return [
                        `## ⚙️ LLM Configuration\n`,
                        `**Status**: ${status}\n`,
                        `### Resolved Provider`,
                        `| Setting | Value |\n|---------|-------|`,
                        providerInfo,
                        `\n### Config`,
                        `| Setting | Value |\n|---------|-------|`,
                        `| Preferred Provider | ${s.config.llm.preferredProvider || "(auto)"} |`,
                        `| Preferred Model | ${s.config.llm.preferredModel || "(auto)"} |`,
                        `| Max Tokens | ${s.config.llm.maxTokens} |`,
                        `| Temperature | ${s.config.llm.temperature} |`,
                        `\n### Config File`,
                        `\`${s.configPath}\``,
                        `\n### How to Configure`,
                        `1. Set provider in \`opencode.json\` → auto-detected`,
                        `2. Or use: \`buddy_config("set_provider", "nvidia")\``,
                        `3. Or use: \`buddy_config("set_model", "moonshotai/kimi-k2.5")\``,
                    ].join("\n");
                }

                if (action === "set_provider" && args.value) {
                    s.config.llm.preferredProvider = args.value;
                    s.resolvedProvider = null;
                    saveConfig(s.configPath, s.config);
                    const status = await getLLMStatus(s);
                    return `✅ Preferred provider set to: ${args.value}\n\nLLM Status: ${status}`;
                }

                if (action === "set_model" && args.value) {
                    s.config.llm.preferredModel = args.value;
                    s.resolvedProvider = null;
                    saveConfig(s.configPath, s.config);
                    return `✅ Preferred model set to: ${args.value}`;
                }

                return `❌ Unknown action: ${action}\n\nAvailable actions: view, set_provider, set_model`;
            },
        }),

        // ========================================
        // LLM TEST
        // ========================================

        buddy_llm_test: tool({
            description: "Test LLM provider connectivity. Lists all available providers and verifies API connection.",
            args: {
                provider: tool.schema.string().optional().describe("Specific provider ID to test (tests all if omitted)"),
            },
            async execute(args) {
                let output = `## 🔌 LLM Provider Test\n\n`;

                try {
                    const result = await s.client.config.providers();
                    if (!result.data) return output + `❌ Failed to query OpenCode providers API`;

                    const providers = result.data.providers || [];
                    if (providers.length === 0) {
                        return output + `⚠️ No providers configured in \`opencode.json\`\n\nPlease add a provider to your \`opencode.json\` config.`;
                    }

                    output += `### Available Providers (${providers.length})\n\n`;

                    for (const p of providers) {
                        if (args.provider && p.id !== args.provider) continue;

                        const modelKeys = Object.keys(p.models || {});
                        const baseURL = (p as any).options?.baseURL || (p as any).options?.baseUrl || "";
                        const apiKey = p.key || (p as any).options?.apiKey || "";

                        output += `#### ${p.name || p.id} (\`${p.id}\`)\n`;
                        output += `- **Source**: ${p.source}\n`;
                        output += `- **Base URL**: ${baseURL || "(not set)"}\n`;
                        output += `- **API Key**: ${apiKey ? "✅ configured" : "❌ not set"}\n`;
                        output += `- **Models**: ${modelKeys.length > 0 ? modelKeys.join(", ") : "(none)"}\n`;

                        if (baseURL && apiKey && modelKeys.length > 0) {
                            const testModel = modelKeys[0];
                            const startTime = Date.now();
                            try {
                                const resp = await fetch(`${baseURL}/chat/completions`, {
                                    method: "POST",
                                    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
                                    body: JSON.stringify({
                                        model: testModel,
                                        messages: [{ role: "user", content: "Hello, respond with just 'OK'." }],
                                        max_tokens: 10,
                                        temperature: 0,
                                    }),
                                });
                                const latency = Date.now() - startTime;
                                if (resp.ok) {
                                    const data = (await resp.json()) as any;
                                    const reply = data.choices?.[0]?.message?.content || "(empty)";
                                    output += `- **Connection Test**: ✅ OK (${latency}ms) — "${reply.trim().substring(0, 50)}"\n`;
                                } else {
                                    output += `- **Connection Test**: ❌ HTTP ${resp.status} (${latency}ms)\n`;
                                }
                            } catch (err: any) {
                                output += `- **Connection Test**: ❌ Error (${Date.now() - startTime}ms): ${err.message || err}\n`;
                            }
                        } else {
                            output += `- **Connection Test**: ⏭️ Skipped (missing baseURL, apiKey, or models)\n`;
                        }
                        output += `\n`;
                    }

                    const resolved = await resolveProvider(s);
                    if (resolved) {
                        output += `### Active Provider\n**${resolved.name}** using model \`${resolved.modelID}\`\n`;
                    }
                } catch (err: any) {
                    output += `❌ Error: ${err.message || err}\n`;
                }

                return output;
            },
        }),

        // ========================================
        // HELP
        // ========================================

        buddy_help: tool({
            description: "Display help for all buddy commands",
            args: {
                command: tool.schema.string().optional().describe("Specific command name"),
            },
            async execute(args) {
                if (args.command) {
                    return `## 📖 Help for ${args.command}\n\nUse buddy_help() without arguments to see all commands.`;
                }
                return `# 🤖 Code Buddy Help (Full Version)

## 🎯 Core Commands
| Command | Description |
|---------|-------------|
| \`buddy_do(task)\` | Execute and analyze a task |
| \`buddy_help()\` | Display this help |

## 🧠 Memory Commands
| Command | Description |
|---------|-------------|
| \`buddy_remember(query)\` | Search memories |
| \`buddy_remember_recent(limit)\` | Get recent memories |
| \`buddy_remember_stats()\` | Memory statistics |
| \`buddy_add_memory(title, content, type)\` | Add memory |

## 🔗 Knowledge Graph
| Command | Description |
|---------|-------------|
| \`buddy_create_entity(name, type, observations)\` | Create entity |
| \`buddy_search_entities(query)\` | Search entities |
| \`buddy_create_relation(from, to, type)\` | Create relation |

## 📝 Error Learning
| Command | Description |
|---------|-------------|
| \`buddy_record_mistake(...)\` | Record AI mistake |
| \`buddy_get_mistake_patterns()\` | Error pattern analysis |

## 📋 Workflow
| Command | Description |
|---------|-------------|
| \`buddy_get_workflow_guidance(phase)\` | Phase guidance |
| \`buddy_get_session_health()\` | Session health |

## 🤖 AI Features
| Command | Description |
|---------|-------------|
| \`buddy_ask_ai(prompt)\` | Ask AI using OpenCode's LLM |
| \`buddy_analyze_code(code)\` | AI code analysis |
| \`buddy_suggest_improvements(context)\` | AI improvement suggestions |

---
📴 Core features work **offline**. AI features use OpenCode's current LLM.`;
            },
        }),

        // ========================================
        // TASK EXECUTION
        // ========================================

        buddy_do: tool({
            description: "Execute a development task - analyzes, records, and optionally executes the task using AI",
            args: {
                task: tool.schema.string().describe("Task description"),
                execute: tool.schema.boolean().optional().describe("Set true to execute the task using AI (default: false)"),
                context: tool.schema.string().optional().describe("Additional context (code, file paths, etc.)"),
            },
            async execute(args) {
                const taskType = detectTaskType(args.task);
                const complexity = estimateComplexity(args.task);

                const dedupResult = await addMemoryWithDedup(s, {
                    type: taskType === "fix" ? "bugfix" : "feature",
                    title: `Task: ${args.task.substring(0, 50)}...`,
                    content: args.task + (args.context ? `\n\nContext: ${args.context}` : ""),
                    tags: ["buddy-do", taskType, complexity],
                }, false);

                s.session.tasksCompleted++;
                s.session.lastActivity = Date.now();

                let statusMsg = "";
                if (dedupResult.action === "created") statusMsg = `💾 Task saved (ID: ${dedupResult.entry?.id})`;
                else if (dedupResult.action === "merged") statusMsg = `🔄 Merged with existing task`;
                else statusMsg = `⚠️ Similar task exists`;

                let output = `## 🎯 Task: ${args.task}\n\n**Type**: ${taskType} | **Complexity**: ${complexity}\n**Status**: ${statusMsg}\n\n`;

                if (args.execute === true) {
                    const aiResponse = await askAI(s, `You are a development assistant. Execute the following task and provide results.

TASK: ${args.task}

${args.context ? `CONTEXT:\n${args.context}\n` : ""}

TASK TYPE: ${taskType}
COMPLEXITY: ${complexity}

Please provide:
1. **Analysis**: Brief understanding of the task
2. **Solution**: The actual implementation or answer
3. **Next Steps**: What the user should do next

Be concise but thorough. If this involves code, provide the actual code.`);
                    output += `### 🤖 AI Execution Result\n\n${aiResponse}\n\n---\n`;
                }

                const steps = TASK_STEPS[taskType] || TASK_STEPS.task;
                output += `### 📋 Recommended Steps\n${steps.map((st, i) => `${i + 1}. ${st}`).join("\n")}`;
                output += `\n\n> Use \`buddy_remember("${args.task.split(" ").slice(0, 3).join(" ")}")\` to recall this task later.`;

                return output;
            },
        }),

        buddy_done: tool({
            description: "Record a completed task with results and learnings",
            args: {
                task: tool.schema.string().describe("What task was completed"),
                result: tool.schema.string().describe("The outcome/result of the task"),
                learnings: tool.schema.string().optional().describe("Key learnings or insights from this task"),
                type: tool.schema.string().optional().describe("Memory type: decision, bugfix, lesson, pattern, feature, note (default: feature)"),
            },
            async execute(args) {
                const memType = (VALID_MEMORY_TYPES.includes(args.type as MemoryType) ? args.type : "feature") as MemoryType;
                const category = MEMORY_TYPE_CATEGORY[memType] || "knowledge";

                let content = `## Task\n${args.task}\n\n## Result\n${args.result}`;
                if (args.learnings) content += `\n\n## Learnings\n${args.learnings}`;

                const dedupResult = await addMemoryWithDedup(s, {
                    type: memType,
                    category,
                    title: `Done: ${args.task.substring(0, 50)}${args.task.length > 50 ? "..." : ""}`,
                    content,
                    tags: ["buddy-done", category, memType],
                }, false);

                let emoji = "✅";
                let statusMsg = "";
                if (dedupResult.action === "created") statusMsg = `Saved to memory (ID: ${dedupResult.entry?.id})`;
                else if (dedupResult.action === "merged") { emoji = "🔄"; statusMsg = "Merged with existing similar record"; }
                else { emoji = "⚠️"; statusMsg = "Similar record exists - use forceSave to save anyway"; }

                return `${emoji} **Task Completed**: ${args.task}

### 📋 Result
${args.result}

${args.learnings ? `### 💡 Learnings\n${args.learnings}\n` : ""}### 📊 Memory Info
- **Type**: ${memType} (${category})
- **Status**: ${statusMsg}

> Recall with \`buddy_remember("${args.task.split(" ").slice(0, 3).join(" ")}")\``;
            },
        }),

        // ========================================
        // MEMORY
        // ========================================

        buddy_remember: tool({
            description: "Search project memories",
            args: {
                query: tool.schema.string().describe("Search query"),
                limit: tool.schema.number().optional().describe("Max results (default: 5)"),
                type: tool.schema.string().optional().describe("Filter by type"),
            },
            async execute(args) {
                let results = searchText(s.memories, args.query, ["title", "content", "tags"]);
                if (args.type) results = results.filter((m) => m.type === args.type);
                results = results.slice(0, args.limit || 5);

                if (results.length === 0) return `🔍 No memories found for "${args.query}"`;

                let msg = `## 🔍 Search Results for "${args.query}" (${results.length})\n\n`;
                for (const m of results) {
                    msg += `### ${m.title}\n- **Type**: ${m.type}\n- **Date**: ${new Date(m.timestamp).toLocaleDateString()}\n- **Tags**: ${m.tags.join(", ")}\n\n${m.content.substring(0, 150)}...\n\n---\n\n`;
                }
                return msg;
            },
        }),

        buddy_remember_recent: tool({
            description: "Get recent memories",
            args: {
                limit: tool.schema.number().optional().describe("Number of results (default: 5)"),
            },
            async execute(args) {
                const recent = [...s.memories].sort((a, b) => b.timestamp - a.timestamp).slice(0, args.limit || 5);
                if (recent.length === 0) return "📜 No memories yet. Use `buddy_do` to start!";

                let msg = `## 📜 Recent Memories (${recent.length})\n\n`;
                for (const m of recent) {
                    msg += `- **${m.title}** (${m.type}/${getMemoryCategory(m)}) - ${new Date(m.timestamp).toLocaleDateString()}\n`;
                }
                return msg;
            },
        }),

        buddy_remember_by_category: tool({
            description: "Get memories filtered by category (solution or knowledge)",
            args: {
                category: tool.schema.string().describe("Category: 'solution' (decision, bugfix, lesson) or 'knowledge' (pattern, feature, note)"),
                limit: tool.schema.number().optional().describe("Number of results (default: 10)"),
                query: tool.schema.string().optional().describe("Optional search query within category"),
            },
            async execute(args) {
                const cat = args.category.toLowerCase() as MemoryCategory;
                if (!["solution", "knowledge"].includes(cat)) {
                    return `❌ Invalid category: "${args.category}". Use 'solution' or 'knowledge'.`;
                }

                let filtered = cat === "solution" ? s.getSolutionMemories() : s.getKnowledgeMemories();
                if (args.query) filtered = searchText(filtered, args.query, ["title", "content", "tags"]);
                filtered = filtered.sort((a, b) => b.timestamp - a.timestamp).slice(0, args.limit || 10);

                if (filtered.length === 0) {
                    return `📂 No ${cat} memories found${args.query ? ` matching "${args.query}"` : ""}.`;
                }

                const typeLabels = cat === "solution" ? "(decision, bugfix, lesson)" : "(pattern, feature, note)";
                let output = `## 📂 ${cat.charAt(0).toUpperCase() + cat.slice(1)} Memories ${typeLabels}\n\n**Found**: ${filtered.length} item(s)\n\n`;
                for (const m of filtered) {
                    output += `### ${m.title}\n- **Type**: ${m.type} | **ID**: \`${m.id}\`\n- **Date**: ${new Date(m.timestamp).toLocaleString()}\n- **Content**: ${m.content.substring(0, 150)}${m.content.length > 150 ? "..." : ""}\n\n`;
                }
                return output;
            },
        }),

        buddy_remember_stats: tool({
            description: "Get memory and knowledge graph statistics",
            args: {},
            async execute() {
                const byType: Record<string, number> = {};
                for (const m of s.memories) byType[m.type] = (byType[m.type] || 0) + 1;

                return `## 📊 Statistics

### 🧠 Memories
- **Total**: ${s.memories.length}
- **By Category**:
  - 🔧 Solution: ${s.getSolutionMemories().length} (decision, bugfix, lesson)
  - 📚 Knowledge: ${s.getKnowledgeMemories().length} (pattern, feature, note)
- **By Type**: ${Object.entries(byType).map(([t, c]) => `${t}(${c})`).join(", ") || "none"}

### 🔗 Knowledge Graph
- **Entities**: ${s.entities.length}
- **Relations**: ${s.relations.length}

### 📝 Error Learning
- **Mistakes Recorded**: ${s.mistakes.length}

### 💚 Session
- **Tasks Completed**: ${s.session.tasksCompleted}
- **Memories Created**: ${s.session.memoriesCreated}

### 🤖 LLM Configuration
- **Status**: ${await getLLMStatus(s)}
- **Config Path**: ${s.configPath}`;
            },
        }),

        buddy_add_memory: tool({
            description: "Add a memory entry with automatic deduplication. If similar memory exists, will try to merge or ask to confirm",
            args: {
                title: tool.schema.string().describe("Memory title"),
                content: tool.schema.string().describe("Memory content"),
                type: tool.schema.string().describe("Type: decision, pattern, bugfix, lesson, feature, note"),
                tags: tool.schema.array(tool.schema.string()).optional().describe("Tags"),
                forceSave: tool.schema.boolean().optional().describe("Set true to save even if similar memory exists"),
            },
            async execute(args) {
                const tags = (args.tags && args.tags.length > 0)
                    ? args.tags
                    : await autoGenerateTags(s, args.title, args.content, args.type);

                const result = await addMemoryWithDedup(s, {
                    type: args.type as MemoryType,
                    title: args.title,
                    content: args.content,
                    tags,
                }, args.forceSave || false);

                if (result.action === "created") {
                    return `${result.message}\n\nID: ${result.entry?.id}\nType: ${args.type}`;
                }
                if (result.action === "merged") {
                    return `${result.message}\n\n### Merged with:\n- ${result.similarMemories?.[0]?.title}\n\nID: ${result.entry?.id}`;
                }

                let output = `${result.message}\n\n### Similar Memories Found\n\n`;
                for (const sim of result.similarMemories || []) {
                    output += `#### ${sim.title}\n- ID: \`${sim.id}\`\n- Content: ${sim.content.substring(0, 100)}...\n\n`;
                }
                output += `\n---\nTo save anyway, call:\n\`buddy_add_memory(title: "${args.title}", content: "...", type: "${args.type}", forceSave: true)\``;
                return output;
            },
        }),

        buddy_delete_memory: tool({
            description: "Delete memories with two-step confirmation. First call shows what will be deleted, second call with confirmCode executes deletion",
            args: {
                query: tool.schema.string().optional().describe("Search query to find memories to delete"),
                id: tool.schema.string().optional().describe("Specific memory ID to delete"),
                type: tool.schema.string().optional().describe("Delete all memories of this type"),
                confirmCode: tool.schema.string().optional().describe("Confirmation code from step 1 to execute deletion"),
            },
            async execute(args) {
                // Step 2: Execute
                if (args.confirmCode) {
                    if (!s.pendingDeletion) {
                        return `❌ No pending deletion found. Please first call buddy_delete_memory with query, id, or type to select memories to delete.`;
                    }
                    if (args.confirmCode !== s.pendingDeletion.confirmCode) {
                        return `❌ Invalid confirmation code.\n\nExpected: \`${s.pendingDeletion.confirmCode}\`\nReceived: \`${args.confirmCode}\`\n\nPlease use the exact code provided.`;
                    }
                    if (Date.now() - s.pendingDeletion.timestamp > 5 * 60 * 1000) {
                        s.pendingDeletion = null;
                        return `❌ Deletion request expired (5 minute timeout). Please start over.`;
                    }

                    const deletedCount = s.pendingDeletion.ids.length;
                    const deletedItems = s.pendingDeletion.items;
                    const idSet = new Set(s.pendingDeletion.ids);

                    if (s.pendingDeletion.type === "memory") { s.memories = s.memories.filter((m) => !idSet.has(m.id)); s.saveMemories(); }
                    else if (s.pendingDeletion.type === "entity") { s.entities = s.entities.filter((e) => !idSet.has(e.id)); s.saveEntities(); }
                    else if (s.pendingDeletion.type === "relation") { s.relations = s.relations.filter((r) => !idSet.has(r.id)); s.saveRelations(); }
                    else if (s.pendingDeletion.type === "mistake") { s.mistakes = s.mistakes.filter((m) => !idSet.has(m.id)); s.saveMistakes(); }

                    s.pendingDeletion = null;

                    return `## ✅ Deletion Complete\n\n**Deleted**: ${deletedCount} item(s)\n\n### Deleted Items\n${deletedItems.map((i) => `- ${i.title || i.name || i.action || i.id}`).join("\n")}\n\n⚠️ This action cannot be undone.`;
                }

                // Step 1: Preview
                let itemsToDelete: MemoryEntry[] = [];

                if (args.id) {
                    const found = s.memories.find((m) => m.id === args.id);
                    if (!found) return `❌ Memory not found with ID: ${args.id}`;
                    itemsToDelete = [found];
                } else if (args.type) {
                    itemsToDelete = s.memories.filter((m) => m.type === args.type);
                    if (itemsToDelete.length === 0) return `❌ No memories found with type: ${args.type}`;
                } else if (args.query) {
                    itemsToDelete = searchText(s.memories, args.query, ["title", "content", "tags"]);
                    if (itemsToDelete.length === 0) return `❌ No memories found matching: "${args.query}"`;
                } else {
                    return `❌ Please specify one of: query, id, or type to find memories to delete.`;
                }

                const code = generateConfirmCode();
                s.pendingDeletion = {
                    type: "memory",
                    ids: itemsToDelete.map((i) => i.id),
                    items: itemsToDelete,
                    timestamp: Date.now(),
                    confirmCode: code,
                };

                let summary = `## ⚠️ Deletion Confirmation Required\n\n> **WARNING**: This action cannot be undone!\n\n### Items to be Deleted (${itemsToDelete.length})\n\n| ID | Type | Title | Date |\n|----|------|-------|------|\n`;
                for (const item of itemsToDelete.slice(0, 10)) {
                    const date = new Date(item.timestamp).toLocaleDateString();
                    summary += `| \`${item.id.substring(0, 15)}...\` | ${item.type} | ${item.title.substring(0, 30)} | ${date} |\n`;
                }
                if (itemsToDelete.length > 10) summary += `\n... and ${itemsToDelete.length - 10} more items\n`;

                summary += `\n### Content Preview\n`;
                for (const item of itemsToDelete.slice(0, 3)) {
                    summary += `\n#### ${item.title}\n\`\`\`\n${item.content.substring(0, 200)}...\n\`\`\`\n`;
                }

                summary += `\n---\n\n## 🔐 To Confirm Deletion\n\nCall \`buddy_delete_memory\` with confirmation code:\n\n\`\`\`\nbuddy_delete_memory(confirmCode: "${code}")\n\`\`\`\n\n⏰ This code expires in **5 minutes**.\n\nTo cancel, simply do not confirm.`;
                return summary;
            },
        }),

        // ========================================
        // KNOWLEDGE GRAPH
        // ========================================

        buddy_create_entity: tool({
            description: "Create a knowledge entity",
            args: {
                name: tool.schema.string().describe("Entity name"),
                type: tool.schema.string().describe("Type: decision, feature, component, file, bug_fix, lesson, pattern, technology"),
                observations: tool.schema.array(tool.schema.string()).describe("Observations/facts"),
                tags: tool.schema.array(tool.schema.string()).optional().describe("Tags"),
            },
            async execute(args) {
                const entity: Entity = {
                    id: generateId("entity"),
                    name: args.name,
                    type: args.type as EntityType,
                    observations: args.observations,
                    tags: args.tags || [],
                    createdAt: Date.now(),
                };
                s.entities.push(entity);
                s.saveEntities();
                s.session.memoriesCreated++;
                return `✅ Entity created: **${args.name}**\n\nType: ${args.type}\nObservations:\n${args.observations.map((o) => `- ${o}`).join("\n")}`;
            },
        }),

        buddy_search_entities: tool({
            description: "Search knowledge entities",
            args: {
                query: tool.schema.string().describe("Search query"),
                limit: tool.schema.number().optional().describe("Max results (default: 10)"),
            },
            async execute(args) {
                const results = searchText(s.entities, args.query, ["name", "observations", "tags"]).slice(0, args.limit || 10);
                if (results.length === 0) return `🔍 No entities found for "${args.query}"`;

                let msg = `## 🔗 Entities for "${args.query}" (${results.length})\n\n`;
                for (const e of results) {
                    msg += `### ${e.name}\n- **Type**: ${e.type}\n- **Observations**: ${e.observations.slice(0, 2).join("; ")}\n\n`;
                }
                return msg;
            },
        }),

        buddy_create_relation: tool({
            description: "Create a relationship between entities",
            args: {
                from: tool.schema.string().describe("Source entity"),
                to: tool.schema.string().describe("Target entity"),
                type: tool.schema.string().describe("Type: depends_on, implements, related_to, caused_by, fixed_by, uses, extends"),
                description: tool.schema.string().optional().describe("Description"),
            },
            async execute(args) {
                const fromEntity = s.entities.find((e) => e.name === args.from);
                const toEntity = s.entities.find((e) => e.name === args.to);
                if (!fromEntity || !toEntity) {
                    return `❌ Cannot create relation. Entity not found: ${!fromEntity ? args.from : args.to}`;
                }
                const rel: Relation = {
                    id: generateId("rel"),
                    from: args.from,
                    to: args.to,
                    type: args.type,
                    description: args.description,
                    createdAt: Date.now(),
                };
                s.relations.push(rel);
                s.saveRelations();
                return `✅ Relation created: ${args.from} --[${args.type}]--> ${args.to}`;
            },
        }),

        // ========================================
        // ERROR LEARNING
        // ========================================

        buddy_record_mistake: tool({
            description: "Record an AI mistake for learning",
            args: {
                action: tool.schema.string().describe("Wrong action taken"),
                errorType: tool.schema.string().describe("Error type"),
                userCorrection: tool.schema.string().describe("User's correction"),
                correctMethod: tool.schema.string().describe("Correct approach"),
                impact: tool.schema.string().describe("Impact"),
                preventionMethod: tool.schema.string().describe("Prevention method"),
                relatedRule: tool.schema.string().optional().describe("Related rule"),
            },
            async execute(args) {
                const record: MistakeRecord = {
                    id: generateId("mistake"),
                    timestamp: Date.now(),
                    action: args.action,
                    errorType: args.errorType as ErrorType,
                    userCorrection: args.userCorrection,
                    correctMethod: args.correctMethod,
                    impact: args.impact,
                    preventionMethod: args.preventionMethod,
                    relatedRule: args.relatedRule,
                };
                s.mistakes.push(record);
                s.saveMistakes();
                s.session.errorsRecorded++;
                return `## 📝 Mistake Recorded\n\n**ID**: ${record.id}\n**Type**: ${args.errorType}\n\n### ❌ Wrong Action\n${args.action}\n\n### ✅ Correct Method\n${args.correctMethod}\n\n### 🛡️ Prevention\n${args.preventionMethod}`;
            },
        }),

        buddy_get_mistake_patterns: tool({
            description: "Get error pattern analysis",
            args: {},
            async execute() {
                if (s.mistakes.length === 0) return "📝 No mistakes recorded yet. 🎉";

                const byType: Record<string, number> = {};
                for (const m of s.mistakes) byType[m.errorType] = (byType[m.errorType] || 0) + 1;

                let msg = `## 📝 Error Pattern Analysis\n\n**Total**: ${s.mistakes.length}\n\n### By Type\n`;
                for (const [type, count] of Object.entries(byType)) {
                    msg += `- ${type}: ${count}\n`;
                }
                msg += `\n### Recent Mistakes\n`;
                for (const m of s.mistakes.slice(-3)) {
                    msg += `- ${m.action.substring(0, 50)}... (${m.errorType})\n`;
                }
                return msg;
            },
        }),

        // ========================================
        // WORKFLOW
        // ========================================

        buddy_get_workflow_guidance: tool({
            description: "Get workflow guidance for current phase",
            args: {
                phase: tool.schema.string().describe("Phase: idle, planning, implementing, code-written, testing, reviewing, commit-ready, deploying, completed"),
                filesChanged: tool.schema.array(tool.schema.string()).optional().describe("Changed files"),
                testsPassing: tool.schema.boolean().optional().describe("Tests passing?"),
                hasLintErrors: tool.schema.boolean().optional().describe("Lint errors?"),
            },
            async execute(args) {
                s.session.currentPhase = args.phase;
                s.session.lastActivity = Date.now();

                const warnings: string[] = [];
                if (args.hasLintErrors) warnings.push("⚠️ Fix lint errors");
                if (args.testsPassing === false) warnings.push("❌ Tests failing");

                const pct = WORKFLOW_PROGRESS[args.phase] || 0;
                const bar = "█".repeat(Math.floor(pct / 10)) + "░".repeat(10 - Math.floor(pct / 10));

                return `## 📋 Workflow Guidance

**Phase**: ${args.phase}
**Progress**: ${bar} ${pct}%

${warnings.length > 0 ? `### ⚠️ Warnings\n${warnings.join("\n")}\n` : ""}### 📋 Next Steps
${(WORKFLOW_STEPS[args.phase] || WORKFLOW_STEPS.idle).join("\n")}`;
            },
        }),

        buddy_get_session_health: tool({
            description: "Check session health",
            args: {},
            async execute() {
                const duration = Date.now() - s.session.startTime;
                const hours = duration / (1000 * 60 * 60);
                const mins = Math.floor(duration / 60000);

                const warnings: string[] = [];
                if (hours > 4) warnings.push("⚠️ Working 4+ hours, take a break");
                if (hours > 2 && s.session.tasksCompleted === 0) warnings.push("💭 2+ hours without completing a task");

                const productivity = Math.min(100, Math.round(s.session.tasksCompleted * 30 + s.session.memoriesCreated * 20 + 30 - s.session.errorsRecorded * 5));
                const bar = "█".repeat(Math.floor(productivity / 10)) + "░".repeat(10 - Math.floor(productivity / 10));

                return `## 💚 Session Health

**Duration**: ${mins} minutes
**Status**: ${warnings.length === 0 ? "Healthy ✅" : "Needs Attention ⚠️"}

### 📊 Metrics
- Tasks Completed: ${s.session.tasksCompleted}
- Memories Created: ${s.session.memoriesCreated}
- Errors Recorded: ${s.session.errorsRecorded}
- Productivity: ${bar} ${productivity}%

${warnings.length > 0 ? `### ⚠️ Warnings\n${warnings.join("\n")}` : ""}`;
            },
        }),

        // ========================================
        // AI FEATURES
        // ========================================

        buddy_ask_ai: tool({
            description: "Ask AI using OpenCode's current LLM for any question or analysis",
            args: {
                prompt: tool.schema.string().describe("Question or prompt for the AI"),
            },
            async execute(args) {
                const response = await askAI(s, args.prompt);

                const entry: MemoryEntry = {
                    id: generateId("ai"),
                    type: "note",
                    title: `AI Q: ${args.prompt.substring(0, 40)}...`,
                    content: `Q: ${args.prompt}\n\nA: ${response}`,
                    tags: ["ai-query"],
                    timestamp: Date.now(),
                };
                s.memories.push(entry);
                s.saveMemories();

                return `## 🤖 AI Response\n\n### Question\n${args.prompt}\n\n### Answer\n${response}\n\n💾 Saved to memory.`;
            },
        }),

        buddy_analyze_code: tool({
            description: "Use AI to analyze code and provide insights",
            args: {
                code: tool.schema.string().describe("Code to analyze"),
                focus: tool.schema.string().optional().describe("Focus area: bugs, performance, security, readability, or general"),
            },
            async execute(args) {
                const focus = args.focus || "general";
                const response = await askAI(s, `Analyze the following code with focus on ${focus}:\n\n\`\`\`\n${args.code}\n\`\`\`\n\nProvide:\n1. Summary\n2. Issues found\n3. Suggestions for improvement`);
                return `## 🔍 Code Analysis (${focus})\n\n${response}`;
            },
        }),

        buddy_suggest_improvements: tool({
            description: "Use AI to suggest improvements for current context",
            args: {
                context: tool.schema.string().describe("Current context or problem description"),
                type: tool.schema.string().optional().describe("Type: code, architecture, workflow, documentation"),
            },
            async execute(args) {
                const type = args.type || "general";
                const relevant = searchText(s.memories, args.context, ["title", "content"]).slice(0, 3);
                const memCtx = relevant.length > 0
                    ? `\n\nRelevant past decisions:\n${relevant.map((m) => `- ${m.title}: ${m.content.substring(0, 100)}`).join("\n")}`
                    : "";

                const response = await askAI(s, `Based on this context, suggest improvements for ${type}:\n\n${args.context}${memCtx}\n\nProvide actionable, specific suggestions.`);

                return `## 💡 Improvement Suggestions (${type})\n\n### Context\n${args.context}\n\n### Suggestions\n${response}`;
            },
        }),
    };
}
