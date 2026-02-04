/**
 * OpenCode Code Buddy Plugin - Full Version (Single File)
 * 
 * AI Development Assistant Plugin - Project Memory, Knowledge Graph, Smart Task Execution
 * Fully offline capable, persistent storage
 * Uses OpenCode's built-in LLM for AI-enhanced features
 */

import { tool } from "@opencode-ai/plugin";
import type { Plugin } from "@opencode-ai/plugin";
import * as fs from "fs";
import * as path from "path";

// ============================================
// Local Storage System
// ============================================

class LocalStorage {
    private baseDir: string;

    constructor(projectDir: string) {
        this.baseDir = path.join(projectDir, ".opencode", "code-buddy", "data");
        this.ensureDir();
    }

    private ensureDir(): void {
        if (!fs.existsSync(this.baseDir)) {
            fs.mkdirSync(this.baseDir, { recursive: true });
        }
    }

    read<T>(filename: string, defaultValue: T): T {
        const filePath = path.join(this.baseDir, filename);
        try {
            if (fs.existsSync(filePath)) {
                const content = fs.readFileSync(filePath, "utf-8");
                return JSON.parse(content) as T;
            }
        } catch (error) {
            console.log(`[code-buddy] Error reading ${filename}:`, error);
        }
        return defaultValue;
    }

    write<T>(filename: string, data: T): boolean {
        const filePath = path.join(this.baseDir, filename);
        try {
            this.ensureDir();
            fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
            return true;
        } catch (error) {
            console.log(`[code-buddy] Error writing ${filename}:`, error);
            return false;
        }
    }
}

// ============================================
// Memory Types
// ============================================

type MemoryType = "decision" | "pattern" | "bugfix" | "lesson" | "feature" | "note";
type MemoryCategory = "solution" | "knowledge";
type EntityType = "decision" | "feature" | "component" | "file" | "bug_fix" | "lesson" | "pattern" | "technology";
type ErrorType = "procedure-violation" | "workflow-skip" | "assumption-error" | "validation-skip" |
    "responsibility-lack" | "firefighting" | "dependency-miss" | "integration-error" |
    "deployment-error" | "other";
type WorkflowPhase = "idle" | "planning" | "implementing" | "code-written" | "testing" |
    "test-complete" | "reviewing" | "commit-ready" | "committed" | "deploying" | "completed";

// Memory type to category mapping
const MEMORY_TYPE_CATEGORY: Record<MemoryType, MemoryCategory> = {
    decision: "solution",
    bugfix: "solution",
    lesson: "solution",
    pattern: "knowledge",
    feature: "knowledge",
    note: "knowledge"
};

interface MemoryEntry {
    id: string;
    type: MemoryType;
    category?: MemoryCategory;  // Auto-derived from type if not set
    title: string;
    content: string;
    tags: string[];
    timestamp: number;
}

interface Entity {
    id: string;
    name: string;
    type: EntityType;
    observations: string[];
    tags: string[];
    createdAt: number;
}

interface Relation {
    id: string;
    from: string;
    to: string;
    type: string;
    description?: string;
    createdAt: number;
}

interface MistakeRecord {
    id: string;
    timestamp: number;
    action: string;
    errorType: ErrorType;
    userCorrection: string;
    correctMethod: string;
    impact: string;
    preventionMethod: string;
    relatedRule?: string;
}

interface SessionState {
    sessionId: string;
    startTime: number;
    lastActivity: number;
    tasksCompleted: number;
    memoriesCreated: number;
    errorsRecorded: number;
    currentPhase: string;
}

// ============================================
// LLM Configuration (OpenAI Compatible)
// ============================================

interface LLMConfig {
    enabled: boolean;
    provider: string;
    baseUrl: string;
    apiKey: string;
    model: string;
    maxTokens: number;
    temperature: number;
}

interface PluginConfig {
    llm: LLMConfig;
    storage: {
        dataDir: string;
    };
    features: {
        memory: boolean;
        knowledgeGraph: boolean;
        errorLearning: boolean;
        workflow: boolean;
        ai: boolean;
    };
    hooks: {
        autoRemind: boolean;
        protectEnv: boolean;
        trackFiles: boolean;
        compactionContext: boolean;
    };
}

const defaultConfig: PluginConfig = {
    llm: {
        enabled: true,
        provider: "openai",
        baseUrl: "https://api.openai.com/v1",
        apiKey: "",
        model: "gpt-4o-mini",
        maxTokens: 2048,
        temperature: 0.7
    },
    storage: {
        dataDir: ".opencode/code-buddy/data"
    },
    features: {
        memory: true,
        knowledgeGraph: true,
        errorLearning: true,
        workflow: true,
        ai: true
    },
    hooks: {
        autoRemind: true,        // session.idle - 任務完成提醒
        protectEnv: true,        // tool.execute.before - 保護 .env
        trackFiles: false,       // file.edited - 追蹤檔案 (預設關)
        compactionContext: true  // session.compacting - 壓縮時保留記憶
    }
};

// ============================================
// Main Plugin
// ============================================

export const CodeBuddyPlugin: Plugin = async (ctx) => {
    const { directory, client } = ctx;
    const storage = new LocalStorage(directory);

    // Load configuration
    const configPath = path.join(directory, ".opencode", "code-buddy", "config.json");
    let config: PluginConfig = { ...defaultConfig };
    try {
        if (fs.existsSync(configPath)) {
            const configContent = fs.readFileSync(configPath, "utf-8");
            const loadedConfig = JSON.parse(configContent);
            config = { ...defaultConfig, ...loadedConfig, llm: { ...defaultConfig.llm, ...loadedConfig.llm } };
            console.log("[code-buddy] Config loaded from", configPath);
        } else {
            // Create default config file
            const configDir = path.dirname(configPath);
            if (!fs.existsSync(configDir)) {
                fs.mkdirSync(configDir, { recursive: true });
            }
            fs.writeFileSync(configPath, JSON.stringify(defaultConfig, null, 4), "utf-8");
            console.log("[code-buddy] Default config created at", configPath);
        }
    } catch (error) {
        console.log("[code-buddy] Error loading config:", error);
    }

    // Load data
    let memories: MemoryEntry[] = storage.read("memory.json", []);
    let entities: Entity[] = storage.read("entities.json", []);
    let relations: Relation[] = storage.read("relations.json", []);
    let mistakes: MistakeRecord[] = storage.read("mistakes.json", []);
    let session: SessionState = {
        sessionId: `session_${Date.now()}`,
        startTime: Date.now(),
        lastActivity: Date.now(),
        tasksCompleted: 0,
        memoriesCreated: 0,
        errorsRecorded: 0,
        currentPhase: "idle"
    };

    // Pending deletion state for two-step confirmation
    let pendingDeletion: {
        type: "memory" | "entity" | "relation" | "mistake" | "all";
        ids: string[];
        items: any[];
        timestamp: number;
        confirmCode: string;
    } | null = null;

    // Helper functions
    const generateId = (prefix: string) => `${prefix}_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
    const generateConfirmCode = () => Math.random().toString(36).substring(2, 8).toUpperCase();

    const saveMemories = () => storage.write("memory.json", memories);
    const saveEntities = () => storage.write("entities.json", entities);
    const saveRelations = () => storage.write("relations.json", relations);
    const saveMistakes = () => storage.write("mistakes.json", mistakes);

    const searchText = (items: any[], query: string, fields: string[]) => {
        const lowerQuery = query.toLowerCase();
        return items.filter(item =>
            fields.some(field => {
                const value = item[field];
                if (typeof value === "string") return value.toLowerCase().includes(lowerQuery);
                if (Array.isArray(value)) return value.some(v => String(v).toLowerCase().includes(lowerQuery));
                return false;
            })
        );
    };

    // Get category for a memory (from field or derived from type)
    const getMemoryCategory = (memory: MemoryEntry): MemoryCategory => {
        return memory.category || MEMORY_TYPE_CATEGORY[memory.type] || "knowledge";
    };

    // Category-based filters
    const getSolutionMemories = () => memories.filter(m => getMemoryCategory(m) === "solution");
    const getKnowledgeMemories = () => memories.filter(m => getMemoryCategory(m) === "knowledge");

    const detectTaskType = (task: string) => {
        const lower = task.toLowerCase();
        if (/implement|build|create|add|feature/.test(lower)) return "implement";
        if (/fix|bug|error|issue/.test(lower)) return "fix";
        if (/refactor|improve|optimize/.test(lower)) return "refactor";
        if (/test|spec/.test(lower)) return "test";
        if (/doc|readme/.test(lower)) return "document";
        if (/research|investigate/.test(lower)) return "research";
        return "task";
    };

    const estimateComplexity = (task: string) => {
        const wordCount = task.split(/\s+/).length;
        if (wordCount < 10 || /simple|easy|quick/.test(task.toLowerCase())) return "low";
        if (wordCount > 30 || /complex|difficult|large/.test(task.toLowerCase())) return "high";
        return "medium";
    };

    // AI helper - supports OpenAI-compatible API or fallback to OpenCode's AI
    const askAI = async (prompt: string): Promise<string> => {
        // Try OpenAI-compatible API if configured
        if (config.llm.enabled && config.llm.apiKey) {
            try {
                const response = await fetch(`${config.llm.baseUrl}/chat/completions`, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "Authorization": `Bearer ${config.llm.apiKey}`
                    },
                    body: JSON.stringify({
                        model: config.llm.model,
                        messages: [{ role: "user", content: prompt }],
                        max_tokens: config.llm.maxTokens,
                        temperature: config.llm.temperature
                    })
                });

                if (response.ok) {
                    const data = await response.json() as { choices: Array<{ message: { content: string } }> };
                    if (data.choices && data.choices[0]?.message?.content) {
                        return data.choices[0].message.content;
                    }
                }
            } catch (error) {
                console.log("[code-buddy] OpenAI API error:", error);
            }
        }

        // Fallback: Return structured prompt for OpenCode's AI to interpret
        return `[AI Analysis Request]

Please analyze and respond to the following:

${prompt}

---
Note: This is a buddy_ask_ai tool call. Please provide a helpful response based on your knowledge.`;
    };

    // Get LLM status
    const getLLMStatus = (): string => {
        if (config.llm.enabled && config.llm.apiKey) {
            return `Connected (${config.llm.provider}: ${config.llm.model})`;
        }
        return "Using OpenCode's built-in AI";
    };

    // ============================================
    // Memory Deduplication & Merge
    // ============================================

    // Simple text similarity using Jaccard index
    const calculateSimilarity = (text1: string, text2: string): number => {
        const getWords = (text: string) => new Set(
            text.toLowerCase()
                .replace(/[^\w\s]/g, '')
                .split(/\s+/)
                .filter(w => w.length > 2)
        );
        
        const words1 = getWords(text1);
        const words2 = getWords(text2);
        
        if (words1.size === 0 || words2.size === 0) return 0;
        
        let intersection = 0;
        for (const word of words1) {
            if (words2.has(word)) intersection++;
        }
        
        const union = words1.size + words2.size - intersection;
        return union > 0 ? intersection / union : 0;
    };

    // Check semantic similarity using LLM
    const checkSemanticSimilarity = async (text1: string, text2: string): Promise<{ similar: boolean; score: number; reason: string }> => {
        if (!config.llm.enabled || !config.llm.apiKey) {
            return { similar: false, score: 0, reason: "LLM not configured" };
        }

        const prompt = `Compare these two texts and determine if they are semantically similar (same topic/meaning).

TEXT 1:
${text1.substring(0, 500)}

TEXT 2:
${text2.substring(0, 500)}

Respond in JSON only:
{
  "similar": true/false,
  "score": 0.0-1.0,
  "reason": "brief explanation"
}`;

        try {
            const response = await askAI(prompt);
            const jsonMatch = response.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                const parsed = JSON.parse(jsonMatch[0]);
                return {
                    similar: parsed.similar === true,
                    score: typeof parsed.score === 'number' ? parsed.score : 0,
                    reason: parsed.reason || ""
                };
            }
        } catch (error) {
            console.log("[code-buddy] Semantic similarity error:", error);
        }
        return { similar: false, score: 0, reason: "Parse error" };
    };

    // Find similar memories (Jaccard + optional LLM)
    const findSimilarMemories = async (content: string, title: string, useLLM: boolean = true): Promise<{
        matches: MemoryEntry[];
        method: "jaccard" | "llm" | "both";
    }> => {
        const combined = `${title} ${content}`;
        const jaccardThreshold = 0.35;
        const llmThreshold = 0.6;

        // First pass: Jaccard similarity
        const jaccardMatches = memories.filter(m => {
            const memCombined = `${m.title} ${m.content}`;
            const similarity = calculateSimilarity(combined, memCombined);
            return similarity >= jaccardThreshold;
        });

        // If Jaccard finds matches, return them
        if (jaccardMatches.length > 0) {
            return { matches: jaccardMatches, method: "jaccard" };
        }

        // If LLM is enabled and requested, check semantic similarity
        if (useLLM && config.llm.enabled && config.llm.apiKey && memories.length > 0) {
            // Check top candidates (most recent memories of same type or similar tags)
            const candidates = memories.slice(-10); // Check last 10 memories
            const llmMatches: MemoryEntry[] = [];

            for (const m of candidates) {
                const memCombined = `${m.title} ${m.content}`;
                const result = await checkSemanticSimilarity(combined, memCombined);
                if (result.similar && result.score >= llmThreshold) {
                    llmMatches.push(m);
                    console.log(`[code-buddy] LLM found similar: ${m.title} (${result.score}, ${result.reason})`);
                }
            }

            if (llmMatches.length > 0) {
                return { matches: llmMatches, method: "llm" };
            }
        }

        return { matches: [], method: jaccardMatches.length > 0 ? "jaccard" : "llm" };
    };

    // Merge memories using LLM
    const mergeMemoriesWithAI = async (existing: MemoryEntry, newContent: { title: string; content: string }): Promise<{ title: string; content: string } | null> => {
        const prompt = `You are a memory consolidation assistant. Merge these two related memories into one concise, comprehensive entry.

EXISTING MEMORY:
Title: ${existing.title}
Content: ${existing.content}

NEW MEMORY:
Title: ${newContent.title}
Content: ${newContent.content}

Respond in JSON format only:
{
  "title": "merged title (max 60 chars)",
  "content": "merged content (combine key points, remove duplicates)"
}`;

        try {
            const response = await askAI(prompt);
            
            // Try to parse JSON from response
            const jsonMatch = response.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                const parsed = JSON.parse(jsonMatch[0]);
                if (parsed.title && parsed.content) {
                    return parsed;
                }
            }
        } catch (error) {
            console.log("[code-buddy] Merge error:", error);
        }
        
        // Fallback: Simple concatenation
        return {
            title: newContent.title,
            content: `${existing.content}\n\n---\n[Updated] ${newContent.content}`
        };
    };

    // Add memory with deduplication
    const addMemoryWithDedup = async (entry: Omit<MemoryEntry, 'id' | 'timestamp'>, forceSave: boolean = false): Promise<{
        action: 'created' | 'merged' | 'skipped';
        entry?: MemoryEntry;
        similarMemories?: MemoryEntry[];
        method?: string;
        message: string;
    }> => {
        // Find similar memories (using both Jaccard and LLM)
        const similarResult = await findSimilarMemories(entry.content, entry.title, !forceSave);
        const similar = similarResult.matches;
        
        if (similar.length === 0 || forceSave) {
            // No duplicates, save new entry
            const newEntry: MemoryEntry = {
                ...entry,
                id: generateId("mem"),
                timestamp: Date.now()
            };
            memories.push(newEntry);
            saveMemories();
            session.memoriesCreated++;
            return {
                action: 'created',
                entry: newEntry,
                message: `✅ Memory created: **${entry.title}**`
            };
        }

        // Found similar memories
        if (similar.length === 1 && config.llm.enabled && config.llm.apiKey) {
            // Try to merge with LLM
            const merged = await mergeMemoriesWithAI(similar[0], { title: entry.title, content: entry.content });
            if (merged) {
                // Update existing memory
                const existingIndex = memories.findIndex(m => m.id === similar[0].id);
                if (existingIndex >= 0) {
                    memories[existingIndex].title = merged.title;
                    memories[existingIndex].content = merged.content;
                    memories[existingIndex].timestamp = Date.now();
                    memories[existingIndex].tags = [...new Set([...memories[existingIndex].tags, ...entry.tags])];
                    saveMemories();
                    return {
                        action: 'merged',
                        entry: memories[existingIndex],
                        similarMemories: similar,
                        method: similarResult.method,
                        message: `🔄 Memory merged with existing (${similarResult.method}): **${merged.title}**`
                    };
                }
            }
        }

        // Return similar memories for user decision
        return {
            action: 'skipped',
            similarMemories: similar,
            method: similarResult.method,
            message: `⚠️ Found ${similar.length} similar memor${similar.length === 1 ? 'y' : 'ies'} (via ${similarResult.method}). Use \`forceSave: true\` to save anyway.`
        };
    };

    console.log(`[code-buddy] Plugin initialized - LLM: ${getLLMStatus()}`);


    return {
        tool: {
            // ========================================
            // CONFIG
            // ========================================
            buddy_config: tool({
                description: "View or update LLM configuration (OpenAI-compatible API)",
                args: {
                    action: tool.schema.string().optional().describe("Action: view, set_api_key, set_model, set_base_url"),
                    value: tool.schema.string().optional().describe("Value for the setting")
                },
                async execute(args) {
                    const action = args.action || "view";

                    if (action === "view") {
                        const safeConfig = {
                            ...config.llm,
                            apiKey: config.llm.apiKey ? "***configured***" : "(not set)"
                        };
                        return `## ⚙️ LLM Configuration

**Status**: ${getLLMStatus()}

### Current Settings
| Setting | Value |
|---------|-------|
| Provider | ${safeConfig.provider} |
| Base URL | ${safeConfig.baseUrl} |
| Model | ${safeConfig.model} |
| API Key | ${safeConfig.apiKey} |
| Max Tokens | ${safeConfig.maxTokens} |
| Temperature | ${safeConfig.temperature} |

### Config File
\`${configPath}\`

### How to Configure
1. Edit \`.opencode/code-buddy/config.json\`
2. Or use: \`buddy_config("set_api_key", "your-key")\`
3. Or use: \`buddy_config("set_model", "gpt-4o")\`
4. Or use: \`buddy_config("set_base_url", "https://api.example.com/v1")\``;
                    }

                    if (action === "set_api_key" && args.value) {
                        config.llm.apiKey = args.value;
                        fs.writeFileSync(configPath, JSON.stringify(config, null, 4), "utf-8");
                        return `✅ API Key updated successfully!\n\nLLM Status: ${getLLMStatus()}`;
                    }

                    if (action === "set_model" && args.value) {
                        config.llm.model = args.value;
                        fs.writeFileSync(configPath, JSON.stringify(config, null, 4), "utf-8");
                        return `✅ Model updated to: ${args.value}`;
                    }

                    if (action === "set_base_url" && args.value) {
                        config.llm.baseUrl = args.value;
                        fs.writeFileSync(configPath, JSON.stringify(config, null, 4), "utf-8");
                        return `✅ Base URL updated to: ${args.value}`;
                    }

                    return `❌ Unknown action: ${action}\n\nAvailable actions: view, set_api_key, set_model, set_base_url`;
                }
            }),

            // ========================================
            // HELP
            // ========================================
            buddy_help: tool({
                description: "Display help for all buddy commands",
                args: {
                    command: tool.schema.string().optional().describe("Specific command name")
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
                }
            }),

            // ========================================
            // TASK EXECUTION
            // ========================================
            buddy_do: tool({
                description: "Execute a development task - analyzes, records, and optionally executes the task using AI",
                args: {
                    task: tool.schema.string().describe("Task description"),
                    execute: tool.schema.boolean().optional().describe("Set true to execute the task using AI (default: true)"),
                    context: tool.schema.string().optional().describe("Additional context (code, file paths, etc.)")
                },
                async execute(args) {
                    const taskType = detectTaskType(args.task);
                    const complexity = estimateComplexity(args.task);
                    const shouldExecute = args.execute === true; // Default to false

                    // Use deduplication for task recording
                    const dedupResult = await addMemoryWithDedup({
                        type: taskType === "fix" ? "bugfix" : "feature",
                        title: `Task: ${args.task.substring(0, 50)}...`,
                        content: args.task + (args.context ? `\n\nContext: ${args.context}` : ''),
                        tags: ["buddy-do", taskType, complexity]
                    }, false);

                    session.tasksCompleted++;
                    session.lastActivity = Date.now();

                    const steps = {
                        implement: ["Understand requirements", "Design solution", "Implement code", "Write tests", "Review"],
                        fix: ["Reproduce issue", "Analyze root cause", "Implement fix", "Verify fix", "Add regression test"],
                        refactor: ["Review current code", "Plan changes", "Refactor incrementally", "Test", "Document"],
                        test: ["Identify scenarios", "Write test cases", "Run tests", "Fix failures", "Report"],
                        document: ["Identify audience", "Outline content", "Write docs", "Add examples", "Review"],
                        research: ["Define scope", "Gather info", "Analyze options", "Document findings", "Recommend"],
                        task: ["Clarify goals", "Plan approach", "Execute", "Verify", "Document"]
                    };

                    let statusMsg = "";
                    if (dedupResult.action === 'created') {
                        statusMsg = `💾 Task saved (ID: ${dedupResult.entry?.id})`;
                    } else if (dedupResult.action === 'merged') {
                        statusMsg = `🔄 Merged with existing task`;
                    } else {
                        statusMsg = `⚠️ Similar task exists`;
                    }

                    let output = `## 🎯 Task: ${args.task}

**Type**: ${taskType} | **Complexity**: ${complexity}
**Status**: ${statusMsg}

`;

                    // Execute task using AI if enabled
                    if (shouldExecute) {
                        const executionPrompt = `You are a development assistant. Execute the following task and provide results.

TASK: ${args.task}

${args.context ? `CONTEXT:\n${args.context}\n` : ''}

TASK TYPE: ${taskType}
COMPLEXITY: ${complexity}

Please provide:
1. **Analysis**: Brief understanding of the task
2. **Solution**: The actual implementation or answer
3. **Next Steps**: What the user should do next

Be concise but thorough. If this involves code, provide the actual code.`;

                        const aiResponse = await askAI(executionPrompt);
                        
                        output += `### 🤖 AI Execution Result

${aiResponse}

---
`;
                    }

                    output += `### 📋 Recommended Steps
${(steps[taskType as keyof typeof steps] || steps.task).map((s, i) => `${i + 1}. ${s}`).join("\n")}

> Use \`buddy_remember("${args.task.split(' ').slice(0, 3).join(' ')}")\` to recall this task later.`;

                    return output;
                }
            }),

            buddy_done: tool({
                description: "Record a completed task with results and learnings",
                args: {
                    task: tool.schema.string().describe("What task was completed"),
                    result: tool.schema.string().describe("The outcome/result of the task"),
                    learnings: tool.schema.string().optional().describe("Key learnings or insights from this task"),
                    type: tool.schema.string().optional().describe("Memory type: decision, bugfix, lesson, pattern, feature, note (default: feature)")
                },
                async execute(args) {
                    const memoryType = (args.type as MemoryType) || "feature";
                    const category = MEMORY_TYPE_CATEGORY[memoryType] || "knowledge";
                    
                    // Build content with result and learnings
                    let content = `## Task\n${args.task}\n\n## Result\n${args.result}`;
                    if (args.learnings) {
                        content += `\n\n## Learnings\n${args.learnings}`;
                    }

                    // Save with deduplication
                    const result = await addMemoryWithDedup({
                        type: memoryType,
                        category: category,
                        title: `Done: ${args.task.substring(0, 50)}${args.task.length > 50 ? '...' : ''}`,
                        content: content,
                        tags: ["buddy-done", category, memoryType]
                    }, false);

                    let statusEmoji = "✅";
                    let statusMsg = "";
                    
                    if (result.action === 'created') {
                        statusMsg = `Saved to memory (ID: ${result.entry?.id})`;
                    } else if (result.action === 'merged') {
                        statusEmoji = "🔄";
                        statusMsg = `Merged with existing similar record`;
                    } else {
                        statusEmoji = "⚠️";
                        statusMsg = `Similar record exists - use forceSave to save anyway`;
                    }

                    return `${statusEmoji} **Task Completed**: ${args.task}

### 📋 Result
${args.result}

${args.learnings ? `### 💡 Learnings\n${args.learnings}\n` : ''}
### 📊 Memory Info
- **Type**: ${memoryType} (${category})
- **Status**: ${statusMsg}

> Recall with \`buddy_remember("${args.task.split(' ').slice(0, 3).join(' ')}")\``;
                }
            }),

            // ========================================
            // MEMORY
            // ========================================
            buddy_remember: tool({
                description: "Search project memories",
                args: {
                    query: tool.schema.string().describe("Search query"),
                    limit: tool.schema.number().optional().describe("Max results (default: 5)"),
                    type: tool.schema.string().optional().describe("Filter by type")
                },
                async execute(args) {
                    let results = searchText(memories, args.query, ["title", "content", "tags"]);
                    if (args.type) {
                        results = results.filter(m => m.type === args.type);
                    }
                    results = results.slice(0, args.limit || 5);

                    if (results.length === 0) {
                        return `🔍 No memories found for "${args.query}"`;
                    }

                    let msg = `## 🔍 Search Results for "${args.query}" (${results.length})\n\n`;
                    for (const m of results) {
                        msg += `### ${m.title}\n- **Type**: ${m.type}\n- **Date**: ${new Date(m.timestamp).toLocaleDateString()}\n- **Tags**: ${m.tags.join(", ")}\n\n${m.content.substring(0, 150)}...\n\n---\n\n`;
                    }
                    return msg;
                }
            }),

            buddy_remember_recent: tool({
                description: "Get recent memories",
                args: {
                    limit: tool.schema.number().optional().describe("Number of results (default: 5)")
                },
                async execute(args) {
                    const recent = [...memories].sort((a, b) => b.timestamp - a.timestamp).slice(0, args.limit || 5);
                    if (recent.length === 0) {
                        return "📜 No memories yet. Use `buddy_do` to start!";
                    }
                    let msg = `## 📜 Recent Memories (${recent.length})\n\n`;
                    for (const m of recent) {
                        const cat = getMemoryCategory(m);
                        msg += `- **${m.title}** (${m.type}/${cat}) - ${new Date(m.timestamp).toLocaleDateString()}\n`;
                    }
                    return msg;
                }
            }),

            buddy_remember_by_category: tool({
                description: "Get memories filtered by category (solution or knowledge)",
                args: {
                    category: tool.schema.string().describe("Category: 'solution' (decision, bugfix, lesson) or 'knowledge' (pattern, feature, note)"),
                    limit: tool.schema.number().optional().describe("Number of results (default: 10)"),
                    query: tool.schema.string().optional().describe("Optional search query within category")
                },
                async execute(args) {
                    const cat = args.category.toLowerCase() as MemoryCategory;
                    if (!['solution', 'knowledge'].includes(cat)) {
                        return `❌ Invalid category: "${args.category}". Use 'solution' or 'knowledge'.`;
                    }

                    let filtered = cat === 'solution' ? getSolutionMemories() : getKnowledgeMemories();
                    
                    // Apply search query if provided
                    if (args.query) {
                        filtered = searchText(filtered, args.query, ["title", "content", "tags"]);
                    }

                    // Sort by most recent and limit
                    filtered = filtered
                        .sort((a, b) => b.timestamp - a.timestamp)
                        .slice(0, args.limit || 10);

                    if (filtered.length === 0) {
                        return `📂 No ${cat} memories found${args.query ? ` matching "${args.query}"` : ''}.`;
                    }

                    const typeLabels = cat === 'solution' 
                        ? '(decision, bugfix, lesson)'
                        : '(pattern, feature, note)';

                    let output = `## 📂 ${cat.charAt(0).toUpperCase() + cat.slice(1)} Memories ${typeLabels}\n\n`;
                    output += `**Found**: ${filtered.length} item(s)\n\n`;
                    
                    for (const m of filtered) {
                        output += `### ${m.title}\n`;
                        output += `- **Type**: ${m.type} | **ID**: \`${m.id}\`\n`;
                        output += `- **Date**: ${new Date(m.timestamp).toLocaleString()}\n`;
                        output += `- **Content**: ${m.content.substring(0, 150)}${m.content.length > 150 ? '...' : ''}\n\n`;
                    }
                    return output;
                }
            }),

            buddy_remember_stats: tool({
                description: "Get memory and knowledge graph statistics",
                args: {},
                async execute() {
                    const byType: Record<string, number> = {};
                    for (const m of memories) {
                        byType[m.type] = (byType[m.type] || 0) + 1;
                    }
                    
                    const solutionCount = getSolutionMemories().length;
                    const knowledgeCount = getKnowledgeMemories().length;
                    
                    return `## 📊 Statistics

### 🧠 Memories
- **Total**: ${memories.length}
- **By Category**:
  - 🔧 Solution: ${solutionCount} (decision, bugfix, lesson)
  - 📚 Knowledge: ${knowledgeCount} (pattern, feature, note)
- **By Type**: ${Object.entries(byType).map(([t, c]) => `${t}(${c})`).join(", ") || "none"}

### 🔗 Knowledge Graph
- **Entities**: ${entities.length}
- **Relations**: ${relations.length}

### 📝 Error Learning
- **Mistakes Recorded**: ${mistakes.length}

### 💚 Session
- **Tasks Completed**: ${session.tasksCompleted}
- **Memories Created**: ${session.memoriesCreated}

### 🤖 LLM Configuration
- **Status**: ${getLLMStatus()}
- **Config Path**: .opencode/code-buddy/config.json`;
                }
            }),

            buddy_add_memory: tool({
                description: "Add a memory entry with automatic deduplication. If similar memory exists, will try to merge or ask to confirm",
                args: {
                    title: tool.schema.string().describe("Memory title"),
                    content: tool.schema.string().describe("Memory content"),
                    type: tool.schema.string().describe("Type: decision, pattern, bugfix, lesson, feature, note"),
                    tags: tool.schema.array(tool.schema.string()).optional().describe("Tags"),
                    forceSave: tool.schema.boolean().optional().describe("Set true to save even if similar memory exists")
                },
                async execute(args) {
                    const result = await addMemoryWithDedup({
                        type: args.type as MemoryType,
                        title: args.title,
                        content: args.content,
                        tags: args.tags || []
                    }, args.forceSave || false);

                    if (result.action === 'created') {
                        return `${result.message}\n\nID: ${result.entry?.id}\nType: ${args.type}`;
                    }
                    
                    if (result.action === 'merged') {
                        return `${result.message}\n\n### Merged with:\n- ${result.similarMemories?.[0]?.title}\n\nID: ${result.entry?.id}`;
                    }
                    
                    // Skipped - found similar
                    let output = `${result.message}\n\n### Similar Memories Found\n\n`;
                    for (const sim of result.similarMemories || []) {
                        output += `#### ${sim.title}\n`;
                        output += `- ID: \`${sim.id}\`\n`;
                        output += `- Content: ${sim.content.substring(0, 100)}...\n\n`;
                    }
                    output += `\n---\nTo save anyway, call:\n\`buddy_add_memory(title: "${args.title}", content: "...", type: "${args.type}", forceSave: true)\``;
                    return output;
                }
            }),

            buddy_delete_memory: tool({
                description: "Delete memories with two-step confirmation. First call shows what will be deleted, second call with confirmCode executes deletion",
                args: {
                    query: tool.schema.string().optional().describe("Search query to find memories to delete"),
                    id: tool.schema.string().optional().describe("Specific memory ID to delete"),
                    type: tool.schema.string().optional().describe("Delete all memories of this type"),
                    confirmCode: tool.schema.string().optional().describe("Confirmation code from step 1 to execute deletion")
                },
                async execute(args) {
                    // Step 2: Execute deletion if confirmCode is provided
                    if (args.confirmCode) {
                        if (!pendingDeletion) {
                            return `❌ No pending deletion found. Please first call buddy_delete_memory with query, id, or type to select memories to delete.`;
                        }
                        
                        // Check confirmation code
                        if (args.confirmCode !== pendingDeletion.confirmCode) {
                            return `❌ Invalid confirmation code.\n\nExpected: \`${pendingDeletion.confirmCode}\`\nReceived: \`${args.confirmCode}\`\n\nPlease use the exact code provided.`;
                        }
                        
                        // Check if pending deletion is expired (5 minutes)
                        if (Date.now() - pendingDeletion.timestamp > 5 * 60 * 1000) {
                            pendingDeletion = null;
                            return `❌ Deletion request expired (5 minute timeout). Please start over.`;
                        }
                        
                        // Execute deletion
                        const deletedCount = pendingDeletion.ids.length;
                        const deletedItems = pendingDeletion.items;
                        
                        if (pendingDeletion.type === "memory") {
                            memories = memories.filter(m => !pendingDeletion!.ids.includes(m.id));
                            saveMemories();
                        } else if (pendingDeletion.type === "entity") {
                            entities = entities.filter(e => !pendingDeletion!.ids.includes(e.id));
                            saveEntities();
                        } else if (pendingDeletion.type === "relation") {
                            relations = relations.filter(r => !pendingDeletion!.ids.includes(r.id));
                            saveRelations();
                        } else if (pendingDeletion.type === "mistake") {
                            mistakes = mistakes.filter(m => !pendingDeletion!.ids.includes(m.id));
                            saveMistakes();
                        }
                        
                        pendingDeletion = null;
                        
                        return `## ✅ Deletion Complete

**Deleted**: ${deletedCount} item(s)

### Deleted Items
${deletedItems.map((item: any) => `- ${item.title || item.name || item.action || item.id}`).join("\n")}

⚠️ This action cannot be undone.`;
                    }
                    
                    // Step 1: Find and show items to delete
                    let itemsToDelete: any[] = [];
                    let deleteType: "memory" | "entity" | "relation" | "mistake" | "all" = "memory";
                    
                    if (args.id) {
                        // Find by specific ID
                        const found = memories.find(m => m.id === args.id);
                        if (found) {
                            itemsToDelete = [found];
                        } else {
                            return `❌ Memory not found with ID: ${args.id}`;
                        }
                    } else if (args.type) {
                        // Find by type
                        itemsToDelete = memories.filter(m => m.type === args.type);
                        if (itemsToDelete.length === 0) {
                            return `❌ No memories found with type: ${args.type}`;
                        }
                    } else if (args.query) {
                        // Search by query
                        itemsToDelete = searchText(memories, args.query, ["title", "content", "tags"]);
                        if (itemsToDelete.length === 0) {
                            return `❌ No memories found matching: "${args.query}"`;
                        }
                    } else {
                        return `❌ Please specify one of: query, id, or type to find memories to delete.`;
                    }
                    
                    // Generate confirmation code
                    const confirmCode = generateConfirmCode();
                    
                    // Store pending deletion
                    pendingDeletion = {
                        type: deleteType,
                        ids: itemsToDelete.map((item: any) => item.id),
                        items: itemsToDelete,
                        timestamp: Date.now(),
                        confirmCode
                    };
                    
                    // Build summary
                    let summary = `## ⚠️ Deletion Confirmation Required

> **WARNING**: This action cannot be undone!

### Items to be Deleted (${itemsToDelete.length})

| ID | Type | Title | Date |
|----|------|-------|------|
`;
                    for (const item of itemsToDelete.slice(0, 10)) {
                        const date = new Date(item.timestamp || item.createdAt).toLocaleDateString();
                        summary += `| \`${item.id.substring(0, 15)}...\` | ${item.type} | ${(item.title || item.name || "").substring(0, 30)} | ${date} |\n`;
                    }
                    
                    if (itemsToDelete.length > 10) {
                        summary += `\n... and ${itemsToDelete.length - 10} more items\n`;
                    }
                    
                    summary += `
### Content Preview
`;
                    for (const item of itemsToDelete.slice(0, 3)) {
                        summary += `
#### ${item.title || item.name}
\`\`\`
${(item.content || item.observations?.join("\n") || "").substring(0, 200)}...
\`\`\`
`;
                    }
                    
                    summary += `
---

## 🔐 To Confirm Deletion

Call \`buddy_delete_memory\` with confirmation code:

\`\`\`
buddy_delete_memory(confirmCode: "${confirmCode}")
\`\`\`

⏰ This code expires in **5 minutes**.

To cancel, simply do not confirm.`;
                    
                    return summary;
                }
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
                    tags: tool.schema.array(tool.schema.string()).optional().describe("Tags")
                },
                async execute(args) {
                    const entity: Entity = {
                        id: generateId("entity"),
                        name: args.name,
                        type: args.type as EntityType,
                        observations: args.observations,
                        tags: args.tags || [],
                        createdAt: Date.now()
                    };
                    entities.push(entity);
                    saveEntities();
                    session.memoriesCreated++;
                    return `✅ Entity created: **${args.name}**\n\nType: ${args.type}\nObservations:\n${args.observations.map(o => `- ${o}`).join("\n")}`;
                }
            }),

            buddy_search_entities: tool({
                description: "Search knowledge entities",
                args: {
                    query: tool.schema.string().describe("Search query"),
                    limit: tool.schema.number().optional().describe("Max results (default: 10)")
                },
                async execute(args) {
                    const results = searchText(entities, args.query, ["name", "observations", "tags"]).slice(0, args.limit || 10);
                    if (results.length === 0) {
                        return `🔍 No entities found for "${args.query}"`;
                    }
                    let msg = `## 🔗 Entities for "${args.query}" (${results.length})\n\n`;
                    for (const e of results) {
                        msg += `### ${e.name}\n- **Type**: ${e.type}\n- **Observations**: ${e.observations.slice(0, 2).join("; ")}\n\n`;
                    }
                    return msg;
                }
            }),

            buddy_create_relation: tool({
                description: "Create a relationship between entities",
                args: {
                    from: tool.schema.string().describe("Source entity"),
                    to: tool.schema.string().describe("Target entity"),
                    type: tool.schema.string().describe("Type: depends_on, implements, related_to, caused_by, fixed_by, uses, extends"),
                    description: tool.schema.string().optional().describe("Description")
                },
                async execute(args) {
                    const fromEntity = entities.find(e => e.name === args.from);
                    const toEntity = entities.find(e => e.name === args.to);
                    if (!fromEntity || !toEntity) {
                        return `❌ Cannot create relation. Entity not found: ${!fromEntity ? args.from : args.to}`;
                    }
                    const relation: Relation = {
                        id: generateId("rel"),
                        from: args.from,
                        to: args.to,
                        type: args.type,
                        description: args.description,
                        createdAt: Date.now()
                    };
                    relations.push(relation);
                    saveRelations();
                    return `✅ Relation created: ${args.from} --[${args.type}]--> ${args.to}`;
                }
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
                    relatedRule: tool.schema.string().optional().describe("Related rule")
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
                        relatedRule: args.relatedRule
                    };
                    mistakes.push(record);
                    saveMistakes();
                    session.errorsRecorded++;
                    return `## 📝 Mistake Recorded

**ID**: ${record.id}
**Type**: ${args.errorType}

### ❌ Wrong Action
${args.action}

### ✅ Correct Method
${args.correctMethod}

### 🛡️ Prevention
${args.preventionMethod}`;
                }
            }),

            buddy_get_mistake_patterns: tool({
                description: "Get error pattern analysis",
                args: {},
                async execute() {
                    if (mistakes.length === 0) {
                        return "📝 No mistakes recorded yet. 🎉";
                    }
                    const byType: Record<string, number> = {};
                    for (const m of mistakes) {
                        byType[m.errorType] = (byType[m.errorType] || 0) + 1;
                    }
                    let msg = `## 📝 Error Pattern Analysis\n\n**Total**: ${mistakes.length}\n\n### By Type\n`;
                    for (const [type, count] of Object.entries(byType)) {
                        msg += `- ${type}: ${count}\n`;
                    }
                    msg += `\n### Recent Mistakes\n`;
                    for (const m of mistakes.slice(-3)) {
                        msg += `- ${m.action.substring(0, 50)}... (${m.errorType})\n`;
                    }
                    return msg;
                }
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
                    hasLintErrors: tool.schema.boolean().optional().describe("Lint errors?")
                },
                async execute(args) {
                    session.currentPhase = args.phase;
                    session.lastActivity = Date.now();

                    const steps: Record<string, string[]> = {
                        idle: ["📋 Define task goals", "🔍 Research existing code", "📝 Create plan"],
                        planning: ["📐 Design interfaces", "🏗️ Confirm architecture", "✅ List acceptance criteria"],
                        implementing: ["💻 Write core logic", "📝 Add comments", "🧪 Write tests"],
                        "code-written": ["🧪 Run tests", "🔍 Check lint", "📖 Update docs"],
                        testing: ["✅ Fix failing tests", "📊 Check coverage", "🔄 Iterate"],
                        reviewing: ["💬 Address feedback", "🔧 Make changes", "✅ Get approval"],
                        "commit-ready": ["📝 Write commit message", "🔄 Update branch", "✅ Commit"],
                        deploying: ["🚀 Monitor deploy", "✅ Verify", "🔍 Check production"],
                        completed: ["📚 Document lessons", "🎉 Celebrate!", "📋 Next task"]
                    };

                    const warnings: string[] = [];
                    if (args.hasLintErrors) warnings.push("⚠️ Fix lint errors");
                    if (args.testsPassing === false) warnings.push("❌ Tests failing");

                    const progress = { idle: 0, planning: 10, implementing: 30, "code-written": 50, testing: 60, reviewing: 80, "commit-ready": 90, deploying: 98, completed: 100 };
                    const pct = progress[args.phase as keyof typeof progress] || 0;
                    const bar = "█".repeat(pct / 10) + "░".repeat(10 - pct / 10);

                    return `## 📋 Workflow Guidance

**Phase**: ${args.phase}
**Progress**: ${bar} ${pct}%

${warnings.length > 0 ? `### ⚠️ Warnings\n${warnings.join("\n")}\n` : ""}
### 📋 Next Steps
${(steps[args.phase] || steps.idle).join("\n")}`;
                }
            }),

            buddy_get_session_health: tool({
                description: "Check session health",
                args: {},
                async execute() {
                    const duration = Date.now() - session.startTime;
                    const hours = duration / (1000 * 60 * 60);
                    const mins = Math.floor(duration / 60000);

                    const warnings: string[] = [];
                    if (hours > 4) warnings.push("⚠️ Working 4+ hours, take a break");
                    if (hours > 2 && session.tasksCompleted === 0) warnings.push("💭 2+ hours without completing a task");

                    const productivity = Math.min(100, Math.round((session.tasksCompleted * 30 + session.memoriesCreated * 20 + 30) - session.errorsRecorded * 5));
                    const bar = "█".repeat(productivity / 10) + "░".repeat(10 - productivity / 10);

                    return `## 💚 Session Health

**Duration**: ${mins} minutes
**Status**: ${warnings.length === 0 ? "Healthy ✅" : "Needs Attention ⚠️"}

### 📊 Metrics
- Tasks Completed: ${session.tasksCompleted}
- Memories Created: ${session.memoriesCreated}
- Errors Recorded: ${session.errorsRecorded}
- Productivity: ${bar} ${productivity}%

${warnings.length > 0 ? `### ⚠️ Warnings\n${warnings.join("\n")}` : ""}`;
                }
            }),

            // ========================================
            // AI FEATURES (Using OpenCode's LLM)
            // ========================================
            buddy_ask_ai: tool({
                description: "Ask AI using OpenCode's current LLM for any question or analysis",
                args: {
                    prompt: tool.schema.string().describe("Question or prompt for the AI")
                },
                async execute(args) {
                    const response = await askAI(args.prompt);

                    // Save to memory
                    const entry: MemoryEntry = {
                        id: generateId("ai"),
                        type: "note",
                        title: `AI Q: ${args.prompt.substring(0, 40)}...`,
                        content: `Q: ${args.prompt}\n\nA: ${response}`,
                        tags: ["ai-query"],
                        timestamp: Date.now()
                    };
                    memories.push(entry);
                    saveMemories();

                    return `## 🤖 AI Response

### Question
${args.prompt}

### Answer
${response}

💾 Saved to memory.`;
                }
            }),

            buddy_analyze_code: tool({
                description: "Use AI to analyze code and provide insights",
                args: {
                    code: tool.schema.string().describe("Code to analyze"),
                    focus: tool.schema.string().optional().describe("Focus area: bugs, performance, security, readability, or general")
                },
                async execute(args) {
                    const focus = args.focus || "general";
                    const prompt = `Analyze the following code with focus on ${focus}:

\`\`\`
${args.code}
\`\`\`

Provide:
1. Summary
2. Issues found
3. Suggestions for improvement`;

                    const response = await askAI(prompt);

                    return `## 🔍 Code Analysis (${focus})

${response}`;
                }
            }),

            buddy_suggest_improvements: tool({
                description: "Use AI to suggest improvements for current context",
                args: {
                    context: tool.schema.string().describe("Current context or problem description"),
                    type: tool.schema.string().optional().describe("Type: code, architecture, workflow, documentation")
                },
                async execute(args) {
                    const type = args.type || "general";

                    // Include relevant memories for context
                    const relevantMemories = searchText(memories, args.context, ["title", "content"]).slice(0, 3);
                    const memoryContext = relevantMemories.length > 0
                        ? `\n\nRelevant past decisions:\n${relevantMemories.map(m => `- ${m.title}: ${m.content.substring(0, 100)}`).join("\n")}`
                        : "";

                    const prompt = `Based on this context, suggest improvements for ${type}:

${args.context}
${memoryContext}

Provide actionable, specific suggestions.`;

                    const response = await askAI(prompt);

                    return `## 💡 Improvement Suggestions (${type})

### Context
${args.context}

### Suggestions
${response}`;
                }
            })
        },

        // ========================================
        // EVENT HOOKS
        // ========================================

        // Hook: session.idle - 任務完成時提醒
        event: async ({ event }: { event: { type: string; data?: unknown } }) => {
            if (config.hooks.autoRemind && event.type === "session.idle") {
                // 記錄 session 活動
                session.lastActivity = Date.now();
                
                // 如果這個 session 有任務完成，提醒使用者
                if (session.tasksCompleted > 0) {
                    console.log(`[code-buddy] 💡 Reminder: ${session.tasksCompleted} task(s) completed. Use buddy_done to record results.`);
                }
            }
        },

        // Hook: tool.execute.before - 工具執行前攔截
        "tool.execute.before": async (input: { tool: string }, output: { args: { filePath?: string } }) => {
            if (config.hooks.protectEnv) {
                const filePath = output.args?.filePath || "";
                const protectedPatterns = [".env", ".env.local", ".env.production", "secrets"];
                
                for (const pattern of protectedPatterns) {
                    if (filePath.includes(pattern)) {
                        console.log(`[code-buddy] ⚠️ Protected file access blocked: ${filePath}`);
                        throw new Error(`[Code Buddy] Access to protected file "${filePath}" is blocked. Add to config.hooks.protectEnv = false to disable.`);
                    }
                }
            }
        },

        // Hook: file.edited - 檔案編輯追蹤
        "file.edited": async (input: { path: string }) => {
            if (config.hooks.trackFiles && input.path) {
                // 過濾掉一些常見的不需要追蹤的檔案
                const ignoredPatterns = ["node_modules", ".git", "dist", "build", ".next", "package-lock"];
                const shouldTrack = !ignoredPatterns.some(p => input.path.includes(p));
                
                if (shouldTrack) {
                    // 記錄到記憶中
                    await addMemoryWithDedup({
                        type: "feature",
                        category: "knowledge",
                        title: `File edited: ${input.path.split('/').pop()}`,
                        content: `Edited file: ${input.path}`,
                        tags: ["auto-tracked", "file-edit"]
                    }, false);
                    console.log(`[code-buddy] 📝 Tracked file edit: ${input.path}`);
                }
            }
        },

        // Hook: session.compacting - 壓縮時注入記憶
        "experimental.session.compacting": async (_input: unknown, output: { context: string[] }) => {
            if (config.hooks.compactionContext) {
                // 取得最近的記憶
                const recentMemories = [...memories]
                    .sort((a, b) => b.timestamp - a.timestamp)
                    .slice(0, 5);
                
                if (recentMemories.length > 0) {
                    const memoryContext = recentMemories
                        .map(m => `- [${m.type}] ${m.title}`)
                        .join('\n');
                    
                    output.context.push(`## Code Buddy Memory Context

Recent project memories that should persist:

${memoryContext}

Use \`buddy_remember\` to recall more details if needed.`);
                    
                    console.log(`[code-buddy] 📦 Injected ${recentMemories.length} memories into compaction context`);
                }
            }
        }
    };
};

export default CodeBuddyPlugin;
