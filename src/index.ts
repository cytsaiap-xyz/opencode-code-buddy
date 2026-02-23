#!/usr/bin/env node

/**
 * Code Buddy MCP Server
 *
 * Project Memory, Knowledge Graph, Error Learning, Workflow Guidance.
 * Fully offline, persistent JSON storage.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ============================================
// Types
// ============================================

type MemoryType = "decision" | "pattern" | "bugfix" | "lesson" | "feature" | "note";
type MemoryCategory = "solution" | "knowledge";
type EntityType = "decision" | "feature" | "component" | "file" | "bug_fix" | "lesson" | "pattern" | "technology";
type ErrorType =
    | "procedure-violation" | "workflow-skip" | "assumption-error" | "validation-skip"
    | "responsibility-lack" | "firefighting" | "dependency-miss" | "integration-error"
    | "deployment-error" | "other";

const MEMORY_TYPE_CATEGORY: Record<MemoryType, MemoryCategory> = {
    decision: "solution",
    bugfix: "solution",
    lesson: "solution",
    pattern: "knowledge",
    feature: "knowledge",
    note: "knowledge",
};

const VALID_MEMORY_TYPES: MemoryType[] = ["decision", "pattern", "bugfix", "lesson", "feature", "note"];

interface MemoryEntry {
    id: string;
    type: MemoryType;
    category?: MemoryCategory;
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
// Local Storage
// ============================================

class LocalStorage {
    private baseDir: string;

    constructor(dataDir: string) {
        this.baseDir = dataDir;
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
        } catch {
            // Return default on parse error
        }
        return defaultValue;
    }

    write<T>(filename: string, data: T): boolean {
        try {
            this.ensureDir();
            fs.writeFileSync(path.join(this.baseDir, filename), JSON.stringify(data, null, 2), "utf-8");
            return true;
        } catch {
            return false;
        }
    }
}

// ============================================
// Helpers
// ============================================

const generateId = (prefix: string) =>
    `${prefix}_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;

const generateConfirmCode = () =>
    Math.random().toString(36).substring(2, 8).toUpperCase();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function searchText<T extends Record<string, any>>(items: T[], query: string, fields: string[]): T[] {
    const lower = query.toLowerCase();
    return items.filter((item) =>
        fields.some((field) => {
            const value = item[field];
            if (typeof value === "string") return value.toLowerCase().includes(lower);
            if (Array.isArray(value)) return value.some((v: unknown) => String(v).toLowerCase().includes(lower));
            return false;
        }),
    );
}

function getMemoryCategory(m: MemoryEntry): MemoryCategory {
    return m.category || MEMORY_TYPE_CATEGORY[m.type] || "knowledge";
}

/** Jaccard similarity on word sets (words > 2 chars). */
function calculateSimilarity(text1: string, text2: string): number {
    const words = (t: string) =>
        new Set(
            t
                .toLowerCase()
                .replace(/[^\w\s]/g, "")
                .split(/\s+/)
                .filter((w) => w.length > 2),
        );
    const a = words(text1);
    const b = words(text2);
    if (a.size === 0 || b.size === 0) return 0;
    let intersection = 0;
    for (const w of a) if (b.has(w)) intersection++;
    const union = a.size + b.size - intersection;
    return union > 0 ? intersection / union : 0;
}

function detectTaskType(task: string): string {
    const lower = task.toLowerCase();
    if (/implement|build|create|add|feature/.test(lower)) return "implement";
    if (/fix|bug|error|issue/.test(lower)) return "fix";
    if (/refactor|improve|optimize/.test(lower)) return "refactor";
    if (/test|spec/.test(lower)) return "test";
    if (/doc|readme/.test(lower)) return "document";
    if (/research|investigate/.test(lower)) return "research";
    return "task";
}

function estimateComplexity(task: string): string {
    const wordCount = task.split(/\s+/).length;
    if (wordCount < 10 || /simple|easy|quick/.test(task.toLowerCase())) return "low";
    if (wordCount > 30 || /complex|difficult|large/.test(task.toLowerCase())) return "high";
    return "medium";
}

// ============================================
// Bootstrap
// ============================================

const DATA_DIR = path.join(os.homedir(), ".config", "code-buddy", "data");
const storage = new LocalStorage(DATA_DIR);

let memories: MemoryEntry[] = storage.read("memory.json", []);
let entities: Entity[] = storage.read("entities.json", []);
let relations: Relation[] = storage.read("relations.json", []);
let mistakes: MistakeRecord[] = storage.read("mistakes.json", []);

const saveMemories = () => storage.write("memory.json", memories);
const saveEntities = () => storage.write("entities.json", entities);
const saveRelations = () => storage.write("relations.json", relations);
const saveMistakes = () => storage.write("mistakes.json", mistakes);

const session: SessionState = {
    sessionId: `session_${Date.now()}`,
    startTime: Date.now(),
    lastActivity: Date.now(),
    tasksCompleted: 0,
    memoriesCreated: 0,
    errorsRecorded: 0,
    currentPhase: "idle",
};

let pendingDeletion: {
    type: "memory" | "entity" | "relation" | "mistake";
    ids: string[];
    items: Array<Record<string, unknown>>;
    timestamp: number;
    confirmCode: string;
} | null = null;

// ============================================
// Deduplication (Jaccard-only, no LLM needed)
// ============================================

function findSimilarMemories(content: string, title: string): MemoryEntry[] {
    const combined = `${title} ${content}`;
    const threshold = 0.35;
    return memories.filter((m) => {
        const sim = calculateSimilarity(combined, `${m.title} ${m.content}`);
        return sim >= threshold;
    });
}

function addMemoryWithDedup(
    entry: Omit<MemoryEntry, "id" | "timestamp">,
    forceSave: boolean,
): { action: "created" | "skipped"; entry?: MemoryEntry; similar?: MemoryEntry[]; message: string } {
    const similar = forceSave ? [] : findSimilarMemories(entry.content, entry.title);

    if (similar.length === 0) {
        const newEntry: MemoryEntry = { ...entry, id: generateId("mem"), timestamp: Date.now() };
        memories.push(newEntry);
        saveMemories();
        session.memoriesCreated++;
        return { action: "created", entry: newEntry, message: `Memory created: ${entry.title}` };
    }

    return {
        action: "skipped",
        similar,
        message: `Found ${similar.length} similar memory(s). Use forceSave=true to save anyway.`,
    };
}

// ============================================
// MCP Server
// ============================================

const server = new McpServer({
    name: "code-buddy",
    version: "3.0.0",
});

// ---- buddy_do ----
server.tool(
    "buddy_do",
    "Start a development task - analyzes type and complexity, records to memory, returns recommended steps",
    {
        task: z.string().describe("Task description"),
        context: z.string().optional().describe("Additional context (code, file paths, etc.)"),
    },
    async ({ task, context }) => {
        const taskType = detectTaskType(task);
        const complexity = estimateComplexity(task);

        const dedupResult = addMemoryWithDedup(
            {
                type: taskType === "fix" ? "bugfix" : "feature",
                title: `Task: ${task.substring(0, 50)}`,
                content: task + (context ? `\n\nContext: ${context}` : ""),
                tags: ["buddy-do", taskType, complexity],
            },
            false,
        );

        session.tasksCompleted++;
        session.lastActivity = Date.now();

        const steps: Record<string, string[]> = {
            implement: ["Understand requirements", "Design solution", "Implement code", "Write tests", "Review"],
            fix: ["Reproduce issue", "Analyze root cause", "Implement fix", "Verify fix", "Add regression test"],
            refactor: ["Review current code", "Plan changes", "Refactor incrementally", "Test", "Document"],
            test: ["Identify scenarios", "Write test cases", "Run tests", "Fix failures", "Report"],
            document: ["Identify audience", "Outline content", "Write docs", "Add examples", "Review"],
            research: ["Define scope", "Gather info", "Analyze options", "Document findings", "Recommend"],
            task: ["Clarify goals", "Plan approach", "Execute", "Verify", "Document"],
        };

        const statusMsg =
            dedupResult.action === "created"
                ? `Saved (ID: ${dedupResult.entry?.id})`
                : `Similar task exists`;

        const stepList = (steps[taskType] || steps.task).map((s, i) => `${i + 1}. ${s}`).join("\n");

        return {
            content: [
                {
                    type: "text" as const,
                    text: `## Task: ${task}\n\nType: ${taskType} | Complexity: ${complexity}\nStatus: ${statusMsg}\n\n### Recommended Steps\n${stepList}`,
                },
            ],
        };
    },
);

// ---- buddy_done ----
server.tool(
    "buddy_done",
    "Record a completed task with results and learnings",
    {
        task: z.string().describe("What task was completed"),
        result: z.string().describe("The outcome/result"),
        learnings: z.string().optional().describe("Key learnings or insights"),
        type: z
            .enum(["decision", "pattern", "bugfix", "lesson", "feature", "note"])
            .optional()
            .describe("Memory type (default: feature)"),
    },
    async ({ task, result, learnings, type }) => {
        const memType: MemoryType = type || "feature";
        const category = MEMORY_TYPE_CATEGORY[memType];

        let content = `## Task\n${task}\n\n## Result\n${result}`;
        if (learnings) content += `\n\n## Learnings\n${learnings}`;

        const dedupResult = addMemoryWithDedup(
            {
                type: memType,
                category,
                title: `Done: ${task.substring(0, 50)}`,
                content,
                tags: ["buddy-done", category, memType],
            },
            false,
        );

        const statusMsg =
            dedupResult.action === "created"
                ? `Saved (ID: ${dedupResult.entry?.id})`
                : `Similar record exists - use forceSave in buddy_add_memory to save anyway`;

        return {
            content: [
                {
                    type: "text" as const,
                    text: `Task Completed: ${task}\n\nResult:\n${result}\n${learnings ? `\nLearnings:\n${learnings}\n` : ""}\nType: ${memType} (${category})\nStatus: ${statusMsg}`,
                },
            ],
        };
    },
);

// ---- buddy_remember ----
server.tool(
    "buddy_remember",
    "Search project memories by query with optional type filter",
    {
        query: z.string().describe("Search query"),
        limit: z.number().optional().describe("Max results (default: 5)"),
        type: z
            .enum(["decision", "pattern", "bugfix", "lesson", "feature", "note"])
            .optional()
            .describe("Filter by memory type"),
    },
    async ({ query, limit, type }) => {
        let results = searchText(memories, query, ["title", "content", "tags"]);
        if (type) results = results.filter((m) => m.type === type);
        results = results.slice(0, limit || 5);

        if (results.length === 0) {
            return { content: [{ type: "text" as const, text: `No memories found for "${query}"` }] };
        }

        const lines = results.map(
            (m) =>
                `### ${m.title}\nType: ${m.type} | Date: ${new Date(m.timestamp).toLocaleDateString()} | Tags: ${m.tags.join(", ")}\n${m.content.substring(0, 200)}${m.content.length > 200 ? "..." : ""}`,
        );

        return {
            content: [
                {
                    type: "text" as const,
                    text: `## Search Results for "${query}" (${results.length})\n\n${lines.join("\n\n---\n\n")}`,
                },
            ],
        };
    },
);

// ---- buddy_remember_recent ----
server.tool(
    "buddy_remember_recent",
    "Get most recent memories",
    {
        limit: z.number().optional().describe("Number of results (default: 5)"),
    },
    async ({ limit }) => {
        const recent = [...memories].sort((a, b) => b.timestamp - a.timestamp).slice(0, limit || 5);
        if (recent.length === 0) {
            return { content: [{ type: "text" as const, text: "No memories yet." }] };
        }
        const lines = recent.map(
            (m) =>
                `- **${m.title}** (${m.type}/${getMemoryCategory(m)}) - ${new Date(m.timestamp).toLocaleDateString()}`,
        );
        return {
            content: [{ type: "text" as const, text: `## Recent Memories (${recent.length})\n\n${lines.join("\n")}` }],
        };
    },
);

// ---- buddy_remember_by_category ----
server.tool(
    "buddy_remember_by_category",
    "Get memories filtered by category: solution (decision/bugfix/lesson) or knowledge (pattern/feature/note)",
    {
        category: z.enum(["solution", "knowledge"]).describe("Category"),
        limit: z.number().optional().describe("Max results (default: 10)"),
        query: z.string().optional().describe("Optional search query within category"),
    },
    async ({ category, limit, query }) => {
        let filtered = memories.filter((m) => getMemoryCategory(m) === category);
        if (query) filtered = searchText(filtered, query, ["title", "content", "tags"]);
        filtered = filtered.sort((a, b) => b.timestamp - a.timestamp).slice(0, limit || 10);

        if (filtered.length === 0) {
            return {
                content: [
                    {
                        type: "text" as const,
                        text: `No ${category} memories found${query ? ` matching "${query}"` : ""}.`,
                    },
                ],
            };
        }

        const lines = filtered.map(
            (m) =>
                `### ${m.title}\nType: ${m.type} | ID: ${m.id} | Date: ${new Date(m.timestamp).toLocaleString()}\n${m.content.substring(0, 150)}${m.content.length > 150 ? "..." : ""}`,
        );

        return {
            content: [
                {
                    type: "text" as const,
                    text: `## ${category.charAt(0).toUpperCase() + category.slice(1)} Memories\n\nFound: ${filtered.length}\n\n${lines.join("\n\n")}`,
                },
            ],
        };
    },
);

// ---- buddy_remember_stats ----
server.tool("buddy_remember_stats", "Get memory and knowledge graph statistics", {}, async () => {
    const byType: Record<string, number> = {};
    for (const m of memories) byType[m.type] = (byType[m.type] || 0) + 1;

    const solutionCount = memories.filter((m) => getMemoryCategory(m) === "solution").length;
    const knowledgeCount = memories.filter((m) => getMemoryCategory(m) === "knowledge").length;

    return {
        content: [
            {
                type: "text" as const,
                text: `## Statistics

### Memories
- Total: ${memories.length}
- Solution: ${solutionCount} (decision, bugfix, lesson)
- Knowledge: ${knowledgeCount} (pattern, feature, note)
- By Type: ${Object.entries(byType).map(([t, c]) => `${t}(${c})`).join(", ") || "none"}

### Knowledge Graph
- Entities: ${entities.length}
- Relations: ${relations.length}

### Error Learning
- Mistakes Recorded: ${mistakes.length}

### Session
- Tasks Completed: ${session.tasksCompleted}
- Memories Created: ${session.memoriesCreated}
- Data Directory: ${DATA_DIR}`,
            },
        ],
    };
});

// ---- buddy_add_memory ----
server.tool(
    "buddy_add_memory",
    "Add a memory entry with automatic deduplication. If similar memory exists, returns info; use forceSave to override",
    {
        title: z.string().describe("Memory title"),
        content: z.string().describe("Memory content"),
        type: z.enum(["decision", "pattern", "bugfix", "lesson", "feature", "note"]).describe("Memory type"),
        tags: z.array(z.string()).optional().describe("Tags (auto-generated from title if omitted)"),
        forceSave: z.boolean().optional().describe("Save even if similar memory exists"),
    },
    async ({ title, content, type, tags, forceSave }) => {
        const finalTags =
            tags && tags.length > 0
                ? tags
                : title
                      .toLowerCase()
                      .split(/\s+/)
                      .filter((w) => w.length > 3)
                      .slice(0, 3);

        const result = addMemoryWithDedup(
            { type: type as MemoryType, title, content, tags: finalTags },
            forceSave || false,
        );

        if (result.action === "created") {
            return {
                content: [
                    {
                        type: "text" as const,
                        text: `Memory created: ${title}\nID: ${result.entry?.id}\nType: ${type}\nTags: ${finalTags.join(", ")}`,
                    },
                ],
            };
        }

        const similarList = (result.similar || [])
            .map((s) => `- ${s.title} (ID: ${s.id})\n  ${s.content.substring(0, 100)}...`)
            .join("\n");

        return {
            content: [
                {
                    type: "text" as const,
                    text: `${result.message}\n\nSimilar Memories:\n${similarList}\n\nTo save anyway, call buddy_add_memory with forceSave=true.`,
                },
            ],
        };
    },
);

// ---- buddy_delete_memory ----
server.tool(
    "buddy_delete_memory",
    "Delete memories (two-step: first call shows preview + confirmation code, second call with code executes deletion)",
    {
        query: z.string().optional().describe("Search query to find memories to delete"),
        id: z.string().optional().describe("Specific memory ID to delete"),
        type: z
            .enum(["decision", "pattern", "bugfix", "lesson", "feature", "note"])
            .optional()
            .describe("Delete all of this type"),
        confirmCode: z.string().optional().describe("Confirmation code from step 1"),
    },
    async ({ query, id, type, confirmCode }) => {
        // Step 2: execute
        if (confirmCode) {
            if (!pendingDeletion) {
                return {
                    content: [
                        {
                            type: "text" as const,
                            text: "No pending deletion. Call buddy_delete_memory with query, id, or type first.",
                        },
                    ],
                };
            }
            if (confirmCode !== pendingDeletion.confirmCode) {
                return {
                    content: [
                        {
                            type: "text" as const,
                            text: `Invalid code. Expected: ${pendingDeletion.confirmCode}`,
                        },
                    ],
                };
            }
            if (Date.now() - pendingDeletion.timestamp > 5 * 60 * 1000) {
                pendingDeletion = null;
                return {
                    content: [{ type: "text" as const, text: "Deletion expired (5 min). Please start over." }],
                };
            }

            const count = pendingDeletion.ids.length;
            const names = pendingDeletion.items.map(
                (i) => (i.title as string) || (i.name as string) || (i.id as string),
            );

            if (pendingDeletion.type === "memory") {
                memories = memories.filter((m) => !pendingDeletion!.ids.includes(m.id));
                saveMemories();
            } else if (pendingDeletion.type === "entity") {
                entities = entities.filter((e) => !pendingDeletion!.ids.includes(e.id));
                saveEntities();
            } else if (pendingDeletion.type === "relation") {
                relations = relations.filter((r) => !pendingDeletion!.ids.includes(r.id));
                saveRelations();
            } else if (pendingDeletion.type === "mistake") {
                mistakes = mistakes.filter((m) => !pendingDeletion!.ids.includes(m.id));
                saveMistakes();
            }

            pendingDeletion = null;
            return {
                content: [
                    {
                        type: "text" as const,
                        text: `Deleted ${count} item(s):\n${names.map((n) => `- ${n}`).join("\n")}\n\nThis cannot be undone.`,
                    },
                ],
            };
        }

        // Step 1: preview
        let items: MemoryEntry[] = [];

        if (id) {
            const found = memories.find((m) => m.id === id);
            if (!found)
                return { content: [{ type: "text" as const, text: `Memory not found: ${id}` }] };
            items = [found];
        } else if (type) {
            items = memories.filter((m) => m.type === type);
        } else if (query) {
            items = searchText(memories, query, ["title", "content", "tags"]);
        } else {
            return {
                content: [{ type: "text" as const, text: "Provide query, id, or type." }],
            };
        }

        if (items.length === 0) {
            return { content: [{ type: "text" as const, text: "No matching memories found." }] };
        }

        const code = generateConfirmCode();
        pendingDeletion = {
            type: "memory",
            ids: items.map((i) => i.id),
            items: items as unknown as Array<Record<string, unknown>>,
            timestamp: Date.now(),
            confirmCode: code,
        };

        const preview = items
            .slice(0, 10)
            .map(
                (i) =>
                    `- ${i.id} | ${i.type} | ${i.title} | ${new Date(i.timestamp).toLocaleDateString()}`,
            )
            .join("\n");

        return {
            content: [
                {
                    type: "text" as const,
                    text: `## Deletion Preview (${items.length} items)\n\n${preview}${items.length > 10 ? `\n...and ${items.length - 10} more` : ""}\n\nTo confirm, call buddy_delete_memory with confirmCode="${code}"\nExpires in 5 minutes.`,
                },
            ],
        };
    },
);

// ---- buddy_create_entity ----
server.tool(
    "buddy_create_entity",
    "Create a knowledge graph entity",
    {
        name: z.string().describe("Entity name"),
        type: z
            .enum(["decision", "feature", "component", "file", "bug_fix", "lesson", "pattern", "technology"])
            .describe("Entity type"),
        observations: z.array(z.string()).describe("Observations/facts about this entity"),
        tags: z.array(z.string()).optional().describe("Tags"),
    },
    async ({ name, type, observations, tags }) => {
        const entity: Entity = {
            id: generateId("entity"),
            name,
            type: type as EntityType,
            observations,
            tags: tags || [],
            createdAt: Date.now(),
        };
        entities.push(entity);
        saveEntities();
        session.memoriesCreated++;

        return {
            content: [
                {
                    type: "text" as const,
                    text: `Entity created: ${name}\nType: ${type}\nObservations:\n${observations.map((o) => `- ${o}`).join("\n")}`,
                },
            ],
        };
    },
);

// ---- buddy_search_entities ----
server.tool(
    "buddy_search_entities",
    "Search knowledge graph entities",
    {
        query: z.string().describe("Search query"),
        limit: z.number().optional().describe("Max results (default: 10)"),
    },
    async ({ query, limit }) => {
        const results = searchText(entities, query, ["name", "observations", "tags"]).slice(0, limit || 10);
        if (results.length === 0) {
            return { content: [{ type: "text" as const, text: `No entities found for "${query}"` }] };
        }
        const lines = results.map(
            (e) =>
                `### ${e.name}\nType: ${e.type} | ID: ${e.id}\nObservations: ${e.observations.slice(0, 3).join("; ")}${e.observations.length > 3 ? "..." : ""}`,
        );
        return {
            content: [
                {
                    type: "text" as const,
                    text: `## Entities for "${query}" (${results.length})\n\n${lines.join("\n\n")}`,
                },
            ],
        };
    },
);

// ---- buddy_create_relation ----
server.tool(
    "buddy_create_relation",
    "Create a relationship between two knowledge graph entities",
    {
        from: z.string().describe("Source entity name"),
        to: z.string().describe("Target entity name"),
        type: z
            .enum(["depends_on", "implements", "related_to", "caused_by", "fixed_by", "uses", "extends"])
            .describe("Relation type"),
        description: z.string().optional().describe("Description of the relation"),
    },
    async ({ from, to, type, description }) => {
        const fromEntity = entities.find((e) => e.name === from);
        const toEntity = entities.find((e) => e.name === to);
        if (!fromEntity || !toEntity) {
            return {
                content: [
                    {
                        type: "text" as const,
                        text: `Entity not found: ${!fromEntity ? from : to}`,
                    },
                ],
            };
        }
        const relation: Relation = {
            id: generateId("rel"),
            from,
            to,
            type,
            description,
            createdAt: Date.now(),
        };
        relations.push(relation);
        saveRelations();

        return {
            content: [
                {
                    type: "text" as const,
                    text: `Relation created: ${from} --[${type}]--> ${to}${description ? `\nDescription: ${description}` : ""}`,
                },
            ],
        };
    },
);

// ---- buddy_record_mistake ----
server.tool(
    "buddy_record_mistake",
    "Record an AI mistake for pattern learning and future prevention",
    {
        action: z.string().describe("Wrong action that was taken"),
        errorType: z
            .enum([
                "procedure-violation",
                "workflow-skip",
                "assumption-error",
                "validation-skip",
                "responsibility-lack",
                "firefighting",
                "dependency-miss",
                "integration-error",
                "deployment-error",
                "other",
            ])
            .describe("Error type classification"),
        userCorrection: z.string().describe("What the user corrected"),
        correctMethod: z.string().describe("The correct approach"),
        impact: z.string().describe("Impact of the mistake"),
        preventionMethod: z.string().describe("How to prevent this in the future"),
        relatedRule: z.string().optional().describe("Related rule or guideline"),
    },
    async ({ action, errorType, userCorrection, correctMethod, impact, preventionMethod, relatedRule }) => {
        const record: MistakeRecord = {
            id: generateId("mistake"),
            timestamp: Date.now(),
            action,
            errorType: errorType as ErrorType,
            userCorrection,
            correctMethod,
            impact,
            preventionMethod,
            relatedRule,
        };
        mistakes.push(record);
        saveMistakes();
        session.errorsRecorded++;

        return {
            content: [
                {
                    type: "text" as const,
                    text: `Mistake Recorded (ID: ${record.id})\nType: ${errorType}\n\nWrong Action:\n${action}\n\nCorrect Method:\n${correctMethod}\n\nPrevention:\n${preventionMethod}`,
                },
            ],
        };
    },
);

// ---- buddy_get_mistake_patterns ----
server.tool(
    "buddy_get_mistake_patterns",
    "Analyze recorded mistake patterns to identify recurring issues",
    {},
    async () => {
        if (mistakes.length === 0) {
            return { content: [{ type: "text" as const, text: "No mistakes recorded yet." }] };
        }
        const byType: Record<string, number> = {};
        for (const m of mistakes) byType[m.errorType] = (byType[m.errorType] || 0) + 1;

        const typeBreakdown = Object.entries(byType)
            .sort(([, a], [, b]) => b - a)
            .map(([t, c]) => `- ${t}: ${c}`)
            .join("\n");

        const recent = mistakes
            .slice(-5)
            .reverse()
            .map((m) => `- [${m.errorType}] ${m.action.substring(0, 60)}${m.action.length > 60 ? "..." : ""}\n  Prevention: ${m.preventionMethod.substring(0, 80)}`)
            .join("\n");

        return {
            content: [
                {
                    type: "text" as const,
                    text: `## Mistake Patterns\n\nTotal: ${mistakes.length}\n\n### By Type\n${typeBreakdown}\n\n### Recent\n${recent}`,
                },
            ],
        };
    },
);

// ---- buddy_get_workflow_guidance ----
server.tool(
    "buddy_get_workflow_guidance",
    "Get workflow guidance and next steps for the current development phase",
    {
        phase: z
            .enum([
                "idle",
                "planning",
                "implementing",
                "code-written",
                "testing",
                "reviewing",
                "commit-ready",
                "deploying",
                "completed",
            ])
            .describe("Current development phase"),
        filesChanged: z.array(z.string()).optional().describe("List of changed files"),
        testsPassing: z.boolean().optional().describe("Are tests passing?"),
        hasLintErrors: z.boolean().optional().describe("Are there lint errors?"),
    },
    async ({ phase, filesChanged, testsPassing, hasLintErrors }) => {
        session.currentPhase = phase;
        session.lastActivity = Date.now();

        const steps: Record<string, string[]> = {
            idle: ["Define task goals", "Research existing code", "Create plan"],
            planning: ["Design interfaces", "Confirm architecture", "List acceptance criteria"],
            implementing: ["Write core logic", "Add comments", "Write tests"],
            "code-written": ["Run tests", "Check lint", "Update docs"],
            testing: ["Fix failing tests", "Check coverage", "Iterate"],
            reviewing: ["Address feedback", "Make changes", "Get approval"],
            "commit-ready": ["Write commit message", "Update branch", "Commit"],
            deploying: ["Monitor deploy", "Verify", "Check production"],
            completed: ["Document lessons", "Celebrate!", "Next task"],
        };

        const warnings: string[] = [];
        if (hasLintErrors) warnings.push("Fix lint errors before proceeding");
        if (testsPassing === false) warnings.push("Tests are failing - fix before moving on");

        const progress: Record<string, number> = {
            idle: 0, planning: 10, implementing: 30, "code-written": 50,
            testing: 60, reviewing: 80, "commit-ready": 90, deploying: 98, completed: 100,
        };
        const pct = progress[phase] || 0;
        const bar = "=".repeat(Math.floor(pct / 10)) + "-".repeat(10 - Math.floor(pct / 10));

        const stepList = (steps[phase] || steps.idle).map((s, i) => `${i + 1}. ${s}`).join("\n");
        const warningBlock = warnings.length > 0 ? `\nWarnings:\n${warnings.map((w) => `- ${w}`).join("\n")}\n` : "";
        const filesBlock =
            filesChanged && filesChanged.length > 0
                ? `\nFiles Changed: ${filesChanged.length}\n${filesChanged.map((f) => `- ${f}`).join("\n")}\n`
                : "";

        return {
            content: [
                {
                    type: "text" as const,
                    text: `## Workflow: ${phase}\n\nProgress: [${bar}] ${pct}%\n${warningBlock}${filesBlock}\n### Next Steps\n${stepList}`,
                },
            ],
        };
    },
);

// ---- buddy_get_session_health ----
server.tool("buddy_get_session_health", "Check current session health and productivity metrics", {}, async () => {
    const duration = Date.now() - session.startTime;
    const hours = duration / (1000 * 60 * 60);
    const mins = Math.floor(duration / 60000);

    const warnings: string[] = [];
    if (hours > 4) warnings.push("Working 4+ hours - consider a break");
    if (hours > 2 && session.tasksCompleted === 0) warnings.push("2+ hours without completing a task");

    const productivity = Math.min(
        100,
        Math.round(session.tasksCompleted * 30 + session.memoriesCreated * 20 + 30 - session.errorsRecorded * 5),
    );
    const bar = "=".repeat(Math.floor(productivity / 10)) + "-".repeat(10 - Math.floor(productivity / 10));

    return {
        content: [
            {
                type: "text" as const,
                text: `## Session Health

Duration: ${mins} minutes
Status: ${warnings.length === 0 ? "Healthy" : "Needs Attention"}

### Metrics
- Tasks Completed: ${session.tasksCompleted}
- Memories Created: ${session.memoriesCreated}
- Errors Recorded: ${session.errorsRecorded}
- Productivity: [${bar}] ${productivity}%
${warnings.length > 0 ? `\n### Warnings\n${warnings.map((w) => `- ${w}`).join("\n")}` : ""}`,
            },
        ],
    };
});

// ============================================
// Start
// ============================================

async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
}

main().catch((err) => {
    process.stderr.write(`Fatal: ${err}\n`);
    process.exit(1);
});
