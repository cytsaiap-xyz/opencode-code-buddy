/**
 * All event hooks for Code Buddy:
 *  - event (file.edited, session.idle)
 *  - tool.execute.before (env protection)
 *  - tool.execute.after (observer buffer)
 *  - experimental.session.compacting (context injection)
 */

import type { MemoryType, ErrorType, Observation } from "./types";
import { MEMORY_TYPE_CATEGORY, VALID_MEMORY_TYPES } from "./types";
import { generateId } from "./helpers";
import { askAI, addMemoryWithDedup, extractJSON, extractJSONArray } from "./llm";
import type { PluginState } from "./state";

// ============================================
// Write-action detection for observation filter
// ============================================

/** Tool name patterns that indicate a write / mutating action. */
const WRITE_TOOL_PATTERNS = [
    "edit", "write", "create", "delete", "remove", "move", "rename",
    "bash", "shell", "terminal", "exec", "run",
    "insert", "replace", "patch", "apply",
];

/** Returns true if the tool name looks like a write/mutating action. */
function isWriteTool(toolName: string): boolean {
    const lower = toolName.toLowerCase();
    return WRITE_TOOL_PATTERNS.some((p) => lower.includes(p));
}

// ============================================
// Session intent classification
// ============================================

type SessionIntent = "task-execution" | "debugging" | "refactoring" | "exploration";

interface SessionSignals {
    total: number;
    writeRatio: number;
    errorRatio: number;
    /** How concentrated edits are on the same files (0–1, higher = same files repeatedly). */
    fileRepeatScore: number;
    /** Unique edited files / total write observations (0–1, higher = spread across many files). */
    fileDiversity: number;
    /** Whether reads generally precede writes in the buffer. */
    readThenWrite: boolean;
    uniqueEditedFiles: number;
    intent: SessionIntent;
}

function computeSessionSignals(buf: Observation[]): SessionSignals {
    const total = buf.length;
    const writes = buf.filter((o) => o.isWriteAction);
    const errors = buf.filter((o) => o.hasError);
    const writeRatio = total > 0 ? writes.length / total : 0;
    const errorRatio = total > 0 ? errors.length / total : 0;

    // File repeat: count how many times each edited file appears
    const fileCounts: Record<string, number> = {};
    for (const o of buf) {
        if (o.fileEdited) fileCounts[o.fileEdited] = (fileCounts[o.fileEdited] || 0) + 1;
    }
    const uniqueFiles = Object.keys(fileCounts);
    const totalFileRefs = Object.values(fileCounts).reduce((a, b) => a + b, 0);
    const fileRepeatScore = uniqueFiles.length > 0 && totalFileRefs > 0
        ? 1 - (uniqueFiles.length / totalFileRefs)
        : 0;
    const fileDiversity = writes.length > 0 ? uniqueFiles.length / writes.length : 0;

    // Read-then-write: check if the first write comes after at least one read
    const firstWriteIdx = buf.findIndex((o) => o.isWriteAction);
    const firstReadIdx = buf.findIndex((o) => !o.isWriteAction);
    const readThenWrite = firstReadIdx >= 0 && firstWriteIdx > firstReadIdx;

    // Classify intent
    let intent: SessionIntent;
    if (errorRatio >= 0.3 || (errors.length >= 2 && fileRepeatScore >= 0.5)) {
        intent = "debugging";
    } else if (writeRatio >= 0.5 && fileDiversity >= 0.6 && uniqueFiles.length >= 3) {
        intent = "refactoring";
    } else if (writeRatio <= 0.15 && errors.length === 0) {
        intent = "exploration";
    } else {
        intent = "task-execution";
    }

    return {
        total, writeRatio, errorRatio, fileRepeatScore,
        fileDiversity, readThenWrite, uniqueEditedFiles: uniqueFiles.length, intent,
    };
}

/** Build a short context block the AI can use to focus its analysis. */
function buildIntentHint(sig: SessionSignals): string {
    const pct = (n: number) => `${Math.round(n * 100)}%`;
    const lines: string[] = [
        `Session signals: ${sig.total} actions, ${pct(sig.writeRatio)} writes, ${pct(sig.errorRatio)} errors, ${sig.uniqueEditedFiles} unique file(s) edited`,
    ];

    switch (sig.intent) {
        case "debugging":
            lines.push("Intent: DEBUGGING — errors detected or same files revisited repeatedly.");
            lines.push("Focus on: what went wrong, what was tried, what fixed it. Prefer type \"bugfix\" or \"lesson\".");
            break;
        case "refactoring":
            lines.push("Intent: REFACTORING — many files edited with a similar pattern.");
            lines.push("Focus on: what pattern was applied across files, why. Prefer type \"pattern\" or \"decision\".");
            break;
        case "exploration":
            lines.push("Intent: EXPLORATION — mostly reads, no errors, minimal edits.");
            lines.push("Focus on: what was being investigated, key findings. Prefer type \"note\" or \"lesson\".");
            break;
        case "task-execution":
            lines.push("Intent: TASK EXECUTION — focused work with reads then writes.");
            lines.push("Focus on: what was built or changed, the end result. Prefer type \"feature\" or \"bugfix\".");
            break;
    }

    return lines.join("\n");
}

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
                    s.log(`[code-buddy] ⚠️ Protected file access blocked: ${filePath}`);
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

            const fileEdited = (meta.filePath || meta.path || meta.file) as string | undefined;
            const isWriteAction = isWriteTool(input.tool) || !!fileEdited;

            s.pushObservation({
                timestamp: Date.now(),
                tool: input.tool,
                args: meta,
                result: outputStr.substring(0, 200),
                hasError,
                fileEdited,
                isWriteAction,
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
            s.log(`[code-buddy] 📦 Injected ${total} items into compaction context`);
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
    s.log(`[code-buddy] 📝 Tracked file edit: ${filePath}`);
}

async function handleSessionIdle(s: PluginState): Promise<void> {
    s.session.lastActivity = Date.now();

    // Reminder (only when NOT in fullAuto mode)
    if (s.config.hooks.autoRemind && !s.config.hooks.fullAuto && s.session.tasksCompleted > 0) {
        s.log(`[code-buddy] 💡 Reminder: ${s.session.tasksCompleted} task(s) completed. Use buddy_done to record results.`);
    }

    // Auto-observer
    if (!s.config.hooks.autoObserve || s.observationBuffer.length < s.config.hooks.observeMinActions) return;

    // Action-type filter: skip recording for read-only sessions (unless errors detected)
    if (s.config.hooks.requireEditForRecord) {
        const hasWriteAction = s.observationBuffer.some((o) => o.isWriteAction);
        const hasErrors = s.observationBuffer.some((o) => o.hasError);

        if (!hasWriteAction && !hasErrors) {
            s.log("[code-buddy] 📖 Read-only session detected, skipping auto-record");
            s.clearObservations();
            return;
        }
    }

    try {
        if (s.config.hooks.fullAuto) {
            await processFullAutoObserver(s);
        } else {
            await processSingleSummaryObserver(s);
        }
    } catch (err) {
        s.log("[code-buddy] Observer error:", err);
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
    const signals = computeSessionSignals(buf);
    const intentHint = buildIntentHint(signals);

    const observationSummary = buf.map((o) => {
        const time = new Date(o.timestamp).toLocaleTimeString();
        const argsStr = o.args
            ? ` (${Object.entries(o.args).map(([k, v]) => `${k}: ${typeof v === "string" ? v.substring(0, 80) : JSON.stringify(v).substring(0, 80)}`).join(", ")})`
            : "";
        return `[${time}] ${o.tool}${argsStr}${o.result ? `\n  → ${o.result}` : ""}${o.hasError ? " ❌ ERROR" : ""}`;
    }).join("\n");

    s.log(`[code-buddy] 🧠 Intent: ${signals.intent} (writes=${Math.round(signals.writeRatio * 100)}%, errors=${Math.round(signals.errorRatio * 100)}%, files=${signals.uniqueEditedFiles})`);

    const prompt = `You are a development observer AI analyzing a coding session. Produce a JSON ARRAY of memory entries.

${intentHint}

Observations:
${observationSummary}
${hasErrors ? "\n⚠️ Some observations contain errors." : ""}
${editedFiles.length > 0 ? `\n📝 Files edited: ${editedFiles.join(", ")}` : ""}

Rules:
1. **MERGE related actions into a single entry.** Multiple edits to the same component, file area, or logical concern (e.g. three style tweaks to one UI component) MUST become one entry, not three. Group by intent, not by individual tool call.
2. Each entry must have a "category" field: "task", "decision", "error", or "pattern"
3. For "task": what was being worked on (type: "feature", "bugfix", or "note")
4. For "decision": any architectural or technical choice made (type: "decision")
5. For "error": any failed command or error encountered (type: "bugfix" or "lesson")
6. For "pattern": any reusable coding pattern observed (type: "pattern")
7. Each entry needs: category, title (max 60 chars), summary (1-2 sentences), type, tags (3-5 lowercase hyphenated)
8. For "error" entries, add "errorInfo": {"pattern": "...", "solution": "...", "prevention": "..."}
9. Output 1-3 entries. Fewer is better. Don't create entries for trivial observations.
10. **Tags must be specific and descriptive.** Use the actual domain concepts from the code, NOT generic labels.
    - BAD tags: "code-change", "file-edit", "update", "enhancement", "modification"
    - GOOD tags: "ui-layout", "auth-flow", "api-validation", "css-flexbox", "react-hooks", "db-migration"
11. Use the session intent above to guide your focus and preferred memory types.

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
        // Rule-based fallback — group by edited files for meaningful tags
        const fileNames = editedFiles
            .map((f) => (f as string).split("/").pop()?.replace(/\.[^.]+$/, "") || "")
            .filter(Boolean);
        const fileTags = fileNames.length > 0
            ? fileNames.slice(0, 3)
            : [...new Set(buf.map((o) => o.tool))].slice(0, 3);

        const title = editedFiles.length > 0
            ? `Edit ${fileNames.slice(0, 2).join(", ")}${fileNames.length > 2 ? ` +${fileNames.length - 2}` : ""}`
            : `Session: ${[...new Set(buf.map((o) => o.tool))].slice(0, 3).join(", ")}`;

        entries = [{
            category: "task",
            title,
            summary: editedFiles.length > 0
                ? `Edited ${editedFiles.length} file(s): ${editedFiles.join(", ")}`
                : `Used ${buf.length} tool calls across the session`,
            type: "note",
            tags: ["auto-observed", ...fileTags],
        }];
        if (hasErrors) {
            const errorObs = buf.filter((o) => o.hasError);
            const errorFile = errorObs[0]?.fileEdited?.split("/").pop() || errorObs[0]?.tool || "unknown";
            entries.push({
                category: "error",
                title: `Error in ${errorFile}`,
                summary: errorObs.map((o) => o.result || "").join("; ").substring(0, 200),
                type: "bugfix",
                tags: ["auto-error", errorFile.replace(/\.[^.]+$/, "")],
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
            s.log(`[code-buddy] ⚠️ Auto-detected error: ${entry.title}`);
        }
    }

    s.log(`[code-buddy] 🤖 Full Auto: saved ${savedCount} entries from ${buf.length} observations`);
}

// ---- Single summary mode ----

async function processSingleSummaryObserver(s: PluginState): Promise<void> {
    const buf = s.observationBuffer;
    const signals = computeSessionSignals(buf);
    const intentHint = buildIntentHint(signals);

    const observationSummary = buf.map((o) => {
        const time = new Date(o.timestamp).toLocaleTimeString();
        const argsStr = o.args
            ? ` (${Object.entries(o.args).map(([k, v]) => `${k}: ${typeof v === "string" ? v.substring(0, 80) : JSON.stringify(v).substring(0, 80)}`).join(", ")})`
            : "";
        return `[${time}] ${o.tool}${argsStr}${o.result ? `\n  → ${o.result}` : ""}${o.hasError ? " ❌ ERROR" : ""}`;
    }).join("\n");

    s.log(`[code-buddy] 🧠 Intent: ${signals.intent} (writes=${Math.round(signals.writeRatio * 100)}%, errors=${Math.round(signals.errorRatio * 100)}%, files=${signals.uniqueEditedFiles})`);

    const prompt = `You are a development observer AI. Analyze the following tool usage observations and produce a single JSON summary that merges all related work into one cohesive entry.

${intentHint}

Observations:
${observationSummary}

Rules:
1. Summarize the overall intent of the session in 1-2 sentences. Merge related actions (e.g. multiple edits to the same area) into one description.
2. Choose the best memory type based on the session intent above: "decision", "pattern", "bugfix", "lesson", "feature", or "note"
3. Create a concise title (max 60 chars) that captures the high-level goal, not individual steps.
4. Generate 3-5 specific, descriptive tags using actual domain concepts from the code.
   - BAD tags: "code-change", "file-edit", "update", "enhancement"
   - GOOD tags: "ui-layout", "auth-flow", "api-validation", "css-flexbox", "react-hooks"

Respond ONLY with valid JSON:
{"title": "...", "summary": "...", "type": "...", "tags": ["..."]}`;

    const aiResponse = await askAI(s, prompt);

    let parsed: { title: string; summary: string; type: MemoryType; tags: string[] };
    const json = extractJSON(aiResponse);
    if (json?.title) {
        parsed = json;
    } else {
        // Fallback: use file names for meaningful tags instead of raw tool names
        const editedFiles = [...new Set(buf.filter((o) => o.fileEdited).map((o) => o.fileEdited as string))];
        const fileNames = editedFiles
            .map((f) => f.split("/").pop()?.replace(/\.[^.]+$/, "") || "")
            .filter(Boolean);
        const tags = fileNames.length > 0
            ? fileNames.slice(0, 3)
            : [...new Set(buf.map((o) => o.tool))].slice(0, 3);
        parsed = {
            title: editedFiles.length > 0
                ? `Edit ${fileNames.slice(0, 2).join(", ")}`
                : `Session: ${[...new Set(buf.map((o) => o.tool))].slice(0, 3).join(", ")}`,
            summary: editedFiles.length > 0
                ? `Edited ${editedFiles.length} file(s): ${editedFiles.join(", ")}`
                : `Used ${buf.length} tool calls across the session`,
            type: "note",
            tags: ["auto-observed", ...tags],
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

    s.log(`[code-buddy] 🔍 Observer: ${result.message} (from ${buf.length} observations)`);
}
