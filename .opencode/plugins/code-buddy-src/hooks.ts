/**
 * All event hooks for Code Buddy:
 *  - event (file.edited, session.idle)
 *  - tool.execute.before (env protection)
 *  - tool.execute.after (observer buffer)
 *  - experimental.session.compacting (context injection)
 */

import type { MemoryType, ErrorType } from "./types";
import { MEMORY_TYPE_CATEGORY, VALID_MEMORY_TYPES } from "./types";
import { generateId } from "./helpers";
import { askAI, addMemoryWithDedup, extractJSON, extractJSONArray } from "./llm";
import type { PluginState } from "./state";

// ============================================
// Factory — returns all hook handlers
// ============================================

export function createHooks(s: PluginState) {
    return {
        // ---- event: file.edited + session.idle ----
        event: async ({ event }: { event: { type: string; properties?: Record<string, unknown> } }) => {
            if (event.type === "file.edited") {
                handleFileEdited(s, event.properties);
                return;
            }
            if (event.type === "session.idle") {
                await handleSessionIdle(s);
            }
        },

        // ---- tool.execute.before: env file protection ----
        "tool.execute.before": async (_input: { tool: string }, output: { args: { filePath?: string } }) => {
            if (!s.config.hooks.protectEnv) return;

            const filePath = output.args?.filePath || "";
            const protectedPatterns = [".env", ".env.local", ".env.production", "secrets"];
            for (const pattern of protectedPatterns) {
                if (filePath.includes(pattern)) {
                    console.log(`[code-buddy] ⚠️ Protected file access blocked: ${filePath}`);
                    throw new Error(`[Code Buddy] Access to protected file "${filePath}" is blocked. Set config.hooks.protectEnv = false to disable.`);
                }
            }
        },

        // ---- tool.execute.after: background observer ----
        "tool.execute.after": async (input: { tool: string }, output: { output: string; metadata: any }) => {
            if (!s.config.hooks.autoObserve) return;

            const ignoreList = s.config.hooks.observeIgnoreTools || [];
            if (input.tool.startsWith("buddy_") || ignoreList.includes(input.tool)) return;

            const outputStr = typeof output.output === "string" ? output.output : "";

            const errorPatterns = /\b(error|Error|ERROR|failed|FAILED|FAIL|exception|Exception|panic|fatal|Fatal|ENOENT|EACCES|TypeError|ReferenceError|SyntaxError)\b/;
            const hasError = s.config.hooks.autoErrorDetect && errorPatterns.test(outputStr);

            const meta = output.metadata || {};

            s.pushObservation({
                timestamp: Date.now(),
                tool: input.tool,
                args: meta,
                result: outputStr.substring(0, 200),
                hasError,
                fileEdited: (meta.filePath || meta.path || meta.file) as string | undefined,
            });
        },

        // ---- session.compacting: inject memories/mistakes/entities into context ----
        "experimental.session.compacting": async (_input: unknown, output: { context: string[] }) => {
            if (!s.config.hooks.compactionContext) return;

            const recentMemories = [...s.memories].sort((a, b) => b.timestamp - a.timestamp).slice(0, 5);
            const recentMistakes = [...s.mistakes].sort((a, b) => b.timestamp - a.timestamp).slice(0, 3);
            const topEntities = s.entities.slice(0, 5);

            let block = "## Code Buddy Context (Auto-Injected)\n\n";

            if (recentMemories.length > 0) {
                block += "### Recent Memories\n";
                block += recentMemories.map((m) => `- [${m.type}] ${m.title}: ${m.content.substring(0, 80)}`).join("\n");
                block += "\n\n";
            }
            if (recentMistakes.length > 0) {
                block += "### Known Issues (Avoid Repeating)\n";
                block += recentMistakes.map((m) => `- ⚠️ ${m.action} → Solution: ${m.correctMethod.substring(0, 80)}`).join("\n");
                block += "\n\n";
            }
            if (topEntities.length > 0) {
                block += "### Key Entities\n";
                block += topEntities.map((e) => `- ${e.name} (${e.type})`).join("\n");
                block += "\n\n";
            }

            block += "Use `buddy_remember` to recall more details if needed.";
            output.context.push(block);

            const total = recentMemories.length + recentMistakes.length + topEntities.length;
            console.log(`[code-buddy] 📦 Injected ${total} items into compaction context`);
        },
    };
}

// ============================================
// Internal handlers
// ============================================

function handleFileEdited(s: PluginState, properties?: Record<string, unknown>): void {
    const filePath = (properties?.file as string) || "";
    if (!s.config.hooks.trackFiles || !filePath) return;

    const ignored = ["node_modules", ".git", "dist", "build", ".next", "package-lock"];
    if (ignored.some((p) => filePath.includes(p))) return;

    addMemoryWithDedup(s, {
        type: "feature",
        title: `File edited: ${filePath.split("/").pop()}`,
        content: `Edited file: ${filePath}`,
        tags: ["auto-tracked", "file-edit"],
    }, false);
    console.log(`[code-buddy] 📝 Tracked file edit: ${filePath}`);
}

async function handleSessionIdle(s: PluginState): Promise<void> {
    s.session.lastActivity = Date.now();

    // Reminder (only when NOT in fullAuto mode)
    if (s.config.hooks.autoRemind && !s.config.hooks.fullAuto && s.session.tasksCompleted > 0) {
        console.log(`[code-buddy] 💡 Reminder: ${s.session.tasksCompleted} task(s) completed. Use buddy_done to record results.`);
    }

    // Auto-observer
    if (!s.config.hooks.autoObserve || s.observationBuffer.length < s.config.hooks.observeMinActions) return;

    try {
        if (s.config.hooks.fullAuto) {
            await processFullAutoObserver(s);
        } else {
            await processSingleSummaryObserver(s);
        }
    } catch (err) {
        console.log("[code-buddy] Observer error:", err);
    }

    s.clearObservations();
}

// ---- Full Auto: produce multiple categorised entries ----

interface AutoEntry {
    category: string;
    title: string;
    summary: string;
    type: MemoryType;
    tags: string[];
    errorInfo?: { pattern: string; solution: string; prevention: string };
}

async function processFullAutoObserver(s: PluginState): Promise<void> {
    const buf = s.observationBuffer;
    const hasErrors = buf.some((o) => o.hasError);
    const editedFiles = [...new Set(buf.filter((o) => o.fileEdited).map((o) => o.fileEdited))];

    const observationSummary = buf.map((o) => {
        const time = new Date(o.timestamp).toLocaleTimeString();
        const argsStr = o.args
            ? ` (${Object.entries(o.args).map(([k, v]) => `${k}: ${typeof v === "string" ? v.substring(0, 80) : JSON.stringify(v).substring(0, 80)}`).join(", ")})`
            : "";
        return `[${time}] ${o.tool}${argsStr}${o.result ? `\n  → ${o.result}` : ""}${o.hasError ? " ❌ ERROR" : ""}`;
    }).join("\n");

    const prompt = `You are a development observer AI analyzing a coding session. Produce a JSON ARRAY of memory entries.

Observations:
${observationSummary}
${hasErrors ? "\n⚠️ Some observations contain errors." : ""}
${editedFiles.length > 0 ? `\n📝 Files edited: ${editedFiles.join(", ")}` : ""}

Rules:
1. Analyze ALL observations and classify into one or more entries
2. Each entry must have a "category" field: "task", "decision", "error", or "pattern"
3. For "task": what was being worked on (type: "feature", "bugfix", or "note")
4. For "decision": any architectural or technical choice made (type: "decision")
5. For "error": any failed command or error encountered (type: "bugfix" or "lesson")
6. For "pattern": any reusable coding pattern observed (type: "pattern")
7. Each entry needs: category, title (max 60 chars), summary (1-2 sentences), type, tags (3-5 lowercase hyphenated)
8. For "error" entries, add "errorInfo": {"pattern": "...", "solution": "...", "prevention": "..."}
9. Output 1-4 entries. Don't create entries for trivial observations.

Respond ONLY with a valid JSON array:
[{"category": "task", "title": "...", "summary": "...", "type": "feature", "tags": ["..."]}, ...]`;

    const aiResponse = await askAI(s, prompt);

    let entries: AutoEntry[] = [];
    const parsed = extractJSONArray(aiResponse);
    if (parsed) {
        entries = parsed as AutoEntry[];
    } else {
        // Try single object
        const single = extractJSON(aiResponse);
        if (single) entries = [single as AutoEntry];
    }

    if (entries.length === 0) {
        // Rule-based fallback
        const toolNames = [...new Set(buf.map((o) => o.tool))];
        entries = [{
            category: "task",
            title: `Session: ${toolNames.slice(0, 3).join(", ")}`,
            summary: `Used ${buf.length} tools: ${toolNames.join(", ")}`,
            type: "note",
            tags: ["auto-observed", ...toolNames.slice(0, 3)],
        }];
        if (hasErrors) {
            const errorObs = buf.filter((o) => o.hasError);
            entries.push({
                category: "error",
                title: `Error in ${errorObs[0]?.tool || "unknown"}`,
                summary: errorObs.map((o) => o.result || "").join("; ").substring(0, 200),
                type: "bugfix",
                tags: ["auto-error", errorObs[0]?.tool || "unknown"],
            });
        }
    }

    let savedCount = 0;
    for (const entry of entries.slice(0, 4)) {
        if (!VALID_MEMORY_TYPES.includes(entry.type)) entry.type = "note";

        await addMemoryWithDedup(s, {
            type: entry.type,
            category: MEMORY_TYPE_CATEGORY[entry.type],
            title: entry.title,
            content: entry.summary,
            tags: [...(entry.tags || []), "auto-observed", `auto-${entry.category}`],
        }, false);
        savedCount++;

        // Auto-record errors to mistakes.json
        if (entry.category === "error" && s.config.hooks.autoErrorDetect && entry.errorInfo) {
            s.mistakes.push({
                id: generateId("mistake"),
                action: entry.title,
                errorType: "other" as ErrorType,
                userCorrection: entry.summary,
                correctMethod: entry.errorInfo.solution || "",
                impact: entry.errorInfo.pattern || "",
                preventionMethod: entry.errorInfo.prevention || "",
                timestamp: Date.now(),
                relatedRule: "auto-detected",
            });
            s.saveMistakes();
            s.session.errorsRecorded++;
            console.log(`[code-buddy] ⚠️ Auto-detected error: ${entry.title}`);
        }
    }

    console.log(`[code-buddy] 🤖 Full Auto: saved ${savedCount} entries from ${buf.length} observations`);
}

// ---- Single summary mode ----

async function processSingleSummaryObserver(s: PluginState): Promise<void> {
    const buf = s.observationBuffer;

    const observationSummary = buf.map((o) => {
        const time = new Date(o.timestamp).toLocaleTimeString();
        const argsStr = o.args
            ? ` (${Object.entries(o.args).map(([k, v]) => `${k}: ${typeof v === "string" ? v.substring(0, 80) : JSON.stringify(v).substring(0, 80)}`).join(", ")})`
            : "";
        return `[${time}] ${o.tool}${argsStr}${o.result ? `\n  → ${o.result}` : ""}${o.hasError ? " ❌ ERROR" : ""}`;
    }).join("\n");

    const prompt = `You are a development observer AI. Analyze the following tool usage observations and produce a JSON summary.

Observations:
${observationSummary}

Rules:
1. Summarize what was accomplished in 1-2 sentences
2. Choose the best memory type: "decision", "pattern", "bugfix", "lesson", "feature", or "note"
3. Generate 3-5 relevant tags (lowercase, no spaces, use hyphens)
4. Create a concise title (max 60 chars)

Respond ONLY with valid JSON:
{"title": "...", "summary": "...", "type": "...", "tags": ["..."]}`;

    const aiResponse = await askAI(s, prompt);

    let parsed: { title: string; summary: string; type: MemoryType; tags: string[] };
    const json = extractJSON(aiResponse);
    if (json?.title) {
        parsed = json;
    } else {
        const toolNames = [...new Set(buf.map((o) => o.tool))];
        parsed = {
            title: `Session: ${toolNames.slice(0, 3).join(", ")}`,
            summary: `Used ${buf.length} tools: ${toolNames.join(", ")}`,
            type: "note",
            tags: ["auto-observed", ...toolNames.slice(0, 3)],
        };
    }

    if (!VALID_MEMORY_TYPES.includes(parsed.type)) parsed.type = "note";

    const result = await addMemoryWithDedup(s, {
        type: parsed.type,
        category: MEMORY_TYPE_CATEGORY[parsed.type],
        title: parsed.title,
        content: parsed.summary,
        tags: [...(parsed.tags || []), "auto-observed"],
    }, false);

    console.log(`[code-buddy] 🔍 Observer: ${result.message} (from ${buf.length} observations)`);
}
