/**
 * All event hooks for Code Buddy:
 *  - event (file.edited, session.idle)
 *  - tool.execute.before (env protection)
 *  - tool.execute.after (observer buffer)
 *  - experimental.session.compacting (context injection)
 */

import type { MemoryType, ErrorType, Observation } from "./types";
import { MEMORY_TYPE_CATEGORY, VALID_MEMORY_TYPES } from "./types";
import { generateId, formatTime, nowTimestamp } from "./helpers";
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
// Factory — returns all hook handlers
// ============================================

export function createHooks(s: PluginState) {
    return {
        // ---- event: session.idle ----
        event: async ({ event }: { event: { type: string; properties?: Record<string, unknown> } }) => {
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

            // Capture more context for write/edit operations (code content is the valuable part)
            const resultLimit = isWriteAction ? 800 : 300;

            s.pushObservation({
                timestamp: nowTimestamp(),
                tool: input.tool,
                args: meta,
                result: outputStr.substring(0, resultLimit),
                hasError,
                fileEdited,
                isWriteAction,
            });
        },

        // ---- session.compacting: inject memories/mistakes/entities into context ----
        "experimental.session.compacting": async (_input: unknown, output: { context: string[] }) => {
            if (!s.config.hooks.compactionContext) return;

            const recentMemories = [...s.memories].sort((a, b) => b.timestamp.localeCompare(a.timestamp)).slice(0, 5);
            const recentMistakes = [...s.mistakes].sort((a, b) => b.timestamp.localeCompare(a.timestamp)).slice(0, 3);
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

// ---- Shared types for auto-observer entries ----

interface AutoEntry {
    category: string;
    title: string;
    summary: string;
    type: MemoryType;
    tags: string[];
    errorInfo?: { pattern: string; solution: string; prevention: string };
}

interface AutoResponse {
    intent: string;
    entries: AutoEntry[];
}

// ---- Rule-based fallback for when AI classification fails ----

/** Extract a short, readable name from a file path. */
function shortFileName(filePath: string): string {
    return filePath.split("/").pop()?.replace(/\.[^.]+$/, "") || "";
}

/** Extract meaningful action descriptions from an observation's args. */
function describeObservation(o: Observation): string | null {
    const args = o.args || {};

    // Bash/shell commands — extract the actual command
    const cmd = args.command as string | undefined;
    if (cmd) {
        // Truncate long commands, keep the first meaningful part
        const short = cmd.split("&&")[0].split("|")[0].trim();
        return short.length > 60 ? `${short.substring(0, 57)}...` : short;
    }

    // File operations — show file name and action
    const filePath = (args.filePath || args.path || args.file || o.fileEdited) as string | undefined;
    if (filePath) {
        const name = filePath.split("/").pop() || filePath;
        const toolVerb = o.tool.toLowerCase().includes("read") ? "Read"
            : o.tool.toLowerCase().includes("write") ? "Wrote"
            : o.tool.toLowerCase().includes("edit") ? "Edited"
            : o.tool.toLowerCase().includes("glob") ? "Searched"
            : "Touched";
        return `${toolVerb} ${name}`;
    }

    // Search/grep — show the search pattern
    const pattern = (args.pattern || args.query || args.search) as string | undefined;
    if (pattern) return `Searched for "${pattern.substring(0, 40)}"`;

    return null;
}

/**
 * Infer domain-relevant tags from observation data.
 * Looks at file extensions, directory names, and common patterns.
 */
function inferTags(buf: Observation[], editedFiles: string[]): string[] {
    const tags = new Set<string>();

    // Tags from edited file extensions / directories
    for (const f of editedFiles) {
        const parts = f.split("/").filter(Boolean);
        const fileName = parts[parts.length - 1] || "";
        const ext = fileName.split(".").pop()?.toLowerCase() || "";

        // Extension-based tags
        const extMap: Record<string, string> = {
            ts: "typescript", tsx: "react", js: "javascript", jsx: "react",
            css: "css", scss: "styling", html: "html", py: "python",
            go: "golang", rs: "rust", json: "config", yaml: "config",
            yml: "config", toml: "config", sql: "database", md: "docs",
            vue: "vue", svelte: "svelte",
        };
        if (extMap[ext]) tags.add(extMap[ext]);

        // Directory-based tags (look for meaningful directory names)
        for (const dir of parts.slice(0, -1)) {
            const dirLower = dir.toLowerCase();
            const dirTags: Record<string, string> = {
                components: "ui-components", pages: "pages", api: "api",
                hooks: "react-hooks", utils: "utilities", lib: "library",
                tests: "testing", test: "testing", __tests__: "testing",
                styles: "styling", models: "data-model", services: "services",
                middleware: "middleware", routes: "routing", store: "state-mgmt",
                plugins: "plugins", public: "assets", src: "",
            };
            if (dirTags[dirLower] !== undefined && dirTags[dirLower] !== "") {
                tags.add(dirTags[dirLower]);
            }
        }
    }

    // Tags from bash commands
    for (const o of buf) {
        const cmd = (o.args?.command as string || "").toLowerCase();
        if (!cmd) continue;
        if (cmd.includes("npm") || cmd.includes("yarn") || cmd.includes("pnpm")) tags.add("package-mgmt");
        if (cmd.includes("test") || cmd.includes("jest") || cmd.includes("vitest")) tags.add("testing");
        if (cmd.includes("build") || cmd.includes("compile")) tags.add("build");
        if (cmd.includes("lint") || cmd.includes("eslint") || cmd.includes("prettier")) tags.add("linting");
        if (cmd.includes("git")) tags.add("git");
        if (cmd.includes("docker")) tags.add("docker");
    }

    return [...tags].slice(0, 5);
}

/**
 * Classify session intent from observation patterns (no AI needed).
 */
function classifyIntent(buf: Observation[], editedFiles: string[], hasErrors: boolean): {
    intent: string;
    type: MemoryType;
} {
    const writeCount = buf.filter((o) => o.isWriteAction).length;
    const readCount = buf.length - writeCount;
    const errorCount = buf.filter((o) => o.hasError).length;

    if (hasErrors && errorCount >= 2) return { intent: "debugging", type: "bugfix" };
    if (hasErrors && editedFiles.length > 0) return { intent: "debugging", type: "bugfix" };
    if (editedFiles.length >= 3) return { intent: "refactoring", type: "pattern" };
    if (editedFiles.length > 0 && writeCount > readCount) return { intent: "task-execution", type: "feature" };
    if (readCount > writeCount * 2) return { intent: "exploration", type: "note" };
    return { intent: "task-execution", type: editedFiles.length > 0 ? "feature" : "note" };
}

/**
 * Build meaningful fallback entries from raw observation data.
 * Used when AI classification fails or no LLM is available.
 */
function buildFallbackEntries(
    buf: Observation[],
    editedFiles: string[],
    hasErrors: boolean,
): AutoEntry[] {
    const entries: AutoEntry[] = [];
    const { intent, type } = classifyIntent(buf, editedFiles, hasErrors);

    // Collect meaningful action descriptions from observations
    const actions: string[] = [];
    for (const o of buf) {
        const desc = describeObservation(o);
        if (desc && !actions.includes(desc)) actions.push(desc);
    }

    // Build title from actual work done
    const fileNames = editedFiles.map(shortFileName).filter(Boolean);
    let title: string;
    let summary: string;

    if (fileNames.length > 0) {
        // Title from edited files with intent context
        const verb = intent === "debugging" ? "Debug"
            : intent === "refactoring" ? "Refactor"
            : fileNames.length >= 3 ? "Update" : "Work on";
        title = fileNames.length <= 2
            ? `${verb} ${fileNames.join(", ")}`
            : `${verb} ${fileNames.slice(0, 2).join(", ")} +${fileNames.length - 2} more`;

        // Summary from key actions
        const keyActions = actions.slice(0, 4);
        summary = keyActions.length > 0
            ? `${keyActions.join(". ")}. Edited ${editedFiles.length} file(s).`
            : `Edited ${editedFiles.length} file(s): ${editedFiles.map((f) => f.split("/").pop()).join(", ")}`;
    } else {
        // No file edits — describe what happened from actions
        const keyActions = actions.slice(0, 3);
        if (keyActions.length > 0) {
            title = keyActions[0].length <= 60
                ? keyActions[0]
                : `${keyActions[0].substring(0, 57)}...`;
            summary = keyActions.join(". ");
        } else {
            // Absolute last resort — still better than just tool names
            const uniqueTools = [...new Set(buf.map((o) => o.tool))];
            title = `Session activity (${uniqueTools.slice(0, 2).join(", ")})`;
            summary = `Performed ${buf.length} operations using ${uniqueTools.join(", ")}`;
        }
    }

    // Truncate title to 60 chars
    if (title.length > 60) title = `${title.substring(0, 57)}...`;

    // Generate domain-relevant tags instead of raw tool names
    const tags = inferTags(buf, editedFiles);
    // Add file name stems as tags if we didn't get enough domain tags
    if (tags.length < 3 && fileNames.length > 0) {
        for (const fn of fileNames.slice(0, 3 - tags.length)) {
            const tag = fn.toLowerCase().replace(/[^a-z0-9-]/g, "-");
            if (tag && !tags.includes(tag)) tags.push(tag);
        }
    }

    entries.push({
        category: intent === "debugging" ? "error" : "task",
        title,
        summary,
        type,
        tags,
    });

    // Separate error entry if there were errors alongside other work
    if (hasErrors && intent !== "debugging") {
        const errorObs = buf.filter((o) => o.hasError);
        const errorDescs = errorObs
            .map((o) => describeObservation(o) || o.result || "")
            .filter(Boolean);
        const errorFile = errorObs[0]?.fileEdited
            ? shortFileName(errorObs[0].fileEdited)
            : errorObs[0]?.tool || "unknown";

        entries.push({
            category: "error",
            title: `Error in ${errorFile}`.substring(0, 60),
            summary: errorDescs.length > 0
                ? errorDescs.join("; ").substring(0, 200)
                : errorObs.map((o) => o.result || "").join("; ").substring(0, 200),
            type: "bugfix",
            tags: [errorFile.toLowerCase().replace(/[^a-z0-9-]/g, "-")],
        });
    }

    return entries;
}

// ---- Full Auto: produce multiple categorised entries ----

async function processFullAutoObserver(s: PluginState): Promise<void> {
    const buf = s.observationBuffer;
    const hasErrors = buf.some((o) => o.hasError);
    const editedFiles = [...new Set(buf.filter((o) => o.fileEdited).map((o) => o.fileEdited as string))];

    const observationSummary = buf.map((o) => {
        const time = formatTime(o.timestamp);
        const argsStr = o.args
            ? ` (${Object.entries(o.args).map(([k, v]) => `${k}: ${typeof v === "string" ? v.substring(0, 200) : JSON.stringify(v).substring(0, 200)}`).join(", ")})`
            : "";
        return `[${time}] ${o.tool}${argsStr}${o.result ? `\n  → ${o.result}` : ""}${o.hasError ? " ❌ ERROR" : ""}`;
    }).join("\n");

    const prompt = `You are a knowledge extraction AI. Your job is to capture **reusable project knowledge** from a coding session — the kind of information that helps rebuild or extend this project in the future.

Observations:
${observationSummary}
${hasErrors ? "\n⚠️ Some observations contain errors." : ""}
${editedFiles.length > 0 ? `\n📝 Files edited: ${editedFiles.join(", ")}` : ""}

DO NOT record what tools were used or what files were edited. Instead, extract the **knowledge behind the work**:

1. **What is being built?** (e.g. "2048 web game", "REST API for user auth")
2. **Architecture & structure** (e.g. "Single HTML file with embedded CSS/JS", "React components with Context for state")
3. **Tech stack & libraries** (e.g. "vanilla JS + CSS grid", "Next.js + Tailwind + Prisma")
4. **Styling approach** (e.g. "CSS grid for board layout, CSS variables for theming, slide animations via CSS transitions")
5. **Key implementation patterns** (e.g. "Game state as 4x4 matrix, merge logic scans each row left-to-right")
6. **Design decisions & why** (e.g. "Chose CSS grid over flexbox because tiles need precise 2D positioning")

Rules:
- Output 1-3 entries. Fewer is better. SKIP if the session is trivial (just reading files, no real work).
- Each entry must have: category, title (max 60 chars), summary (2-4 sentences of actual knowledge), type, tags
- "category": "task" (what was built), "decision" (architecture/tech choice), "error" (bug + fix), or "pattern" (reusable approach)
- "type": "feature", "decision", "pattern", "bugfix", "lesson", or "note"
- "summary" MUST contain concrete, specific details — file names, CSS properties, function names, library APIs. NOT vague descriptions like "updated the code" or "made changes to files."
- Tags must be domain-specific: "css-grid", "game-state-matrix", "react-context", "slide-animation", NOT generic like "code-change" or "file-edit"
- For "error" entries, add "errorInfo": {"pattern": "...", "solution": "...", "prevention": "..."}

Respond ONLY with valid JSON:
{"intent": "task-execution", "entries": [{"category": "task", "title": "...", "summary": "...", "type": "feature", "tags": ["..."]}]}`;

    const aiResponse = await askAI(s, prompt);

    let intent = "unknown";
    let entries: AutoEntry[] = [];

    // Try wrapper format: { intent, entries }
    const wrapper = extractJSON(aiResponse) as AutoResponse | null;
    if (wrapper?.intent && Array.isArray(wrapper.entries)) {
        intent = wrapper.intent;
        entries = wrapper.entries;
    } else {
        // Fallback: try bare array
        const arr = extractJSONArray(aiResponse);
        if (arr) {
            entries = arr as AutoEntry[];
        } else if (wrapper) {
            // Single entry without wrapper
            entries = [wrapper as unknown as AutoEntry];
        }
    }

    s.log(`[code-buddy] 🧠 AI classified intent: ${intent}`);

    if (entries.length === 0) {
        // Rule-based fallback — extract meaningful info from observations
        const fallback = buildFallbackEntries(buf, editedFiles, hasErrors);
        entries = fallback;
    }

    let savedCount = 0;
    for (const entry of entries.slice(0, 4)) {
        if (!VALID_MEMORY_TYPES.includes(entry.type)) entry.type = "note";

        await addMemoryWithDedup(s, {
            type: entry.type,
            category: MEMORY_TYPE_CATEGORY[entry.type],
            title: entry.title,
            content: entry.summary,
            tags: [...new Set([...(entry.tags || []), "auto-observed", `auto-${entry.category}`])],
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
                timestamp: nowTimestamp(),
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

    const observationSummary = buf.map((o) => {
        const time = formatTime(o.timestamp);
        const argsStr = o.args
            ? ` (${Object.entries(o.args).map(([k, v]) => `${k}: ${typeof v === "string" ? v.substring(0, 200) : JSON.stringify(v).substring(0, 200)}`).join(", ")})`
            : "";
        return `[${time}] ${o.tool}${argsStr}${o.result ? `\n  → ${o.result}` : ""}${o.hasError ? " ❌ ERROR" : ""}`;
    }).join("\n");

    const prompt = `You are a knowledge extraction AI. Analyze the following coding session and extract **reusable project knowledge** — the kind of information that helps rebuild or extend this project in the future.

Observations:
${observationSummary}

DO NOT describe what tools were used. Extract the knowledge behind the work:
- What is being built? (project type and purpose)
- Architecture & file structure choices
- Tech stack, libraries, and frameworks
- Styling/UI approach (CSS strategy, layout method, animations)
- Key implementation patterns (data structures, algorithms, state management)
- Design decisions and their reasoning

Produce a single memory entry:
1. Summary must be 2-4 sentences of **concrete, specific knowledge** — mention file names, CSS properties, function names, library APIs, data structures. NOT "updated files" or "made changes."
2. Type: "feature" (what was built), "decision" (architecture/tech choice), "pattern" (reusable approach), "bugfix", "lesson", or "note"
3. Title (max 60 chars): the high-level project knowledge, e.g. "2048 game: CSS grid board with slide animations"
4. Tags: 3-5 domain-specific tags like "css-grid", "game-state-matrix", "react-context". NOT generic like "code-change" or "file-edit".

Respond ONLY with valid JSON:
{"intent": "task-execution", "title": "...", "summary": "...", "type": "...", "tags": ["..."]}`;

    const aiResponse = await askAI(s, prompt);

    let parsed: { intent?: string; title: string; summary: string; type: MemoryType; tags: string[] };
    const json = extractJSON(aiResponse);
    if (json?.title) {
        parsed = json;
        s.log(`[code-buddy] 🧠 AI classified intent: ${parsed.intent || "unknown"}`);
    } else {
        // Fallback: extract meaningful info from observations
        const editedFiles = [...new Set(buf.filter((o) => o.fileEdited).map((o) => o.fileEdited as string))];
        const fallback = buildFallbackEntries(buf, editedFiles, buf.some((o) => o.hasError));
        const entry = fallback[0];
        parsed = {
            title: entry.title,
            summary: entry.summary,
            type: entry.type,
            tags: entry.tags,
        };
    }

    if (!VALID_MEMORY_TYPES.includes(parsed.type)) parsed.type = "note";

    const result = await addMemoryWithDedup(s, {
        type: parsed.type,
        category: MEMORY_TYPE_CATEGORY[parsed.type],
        title: parsed.title,
        content: parsed.summary,
        tags: [...new Set([...(parsed.tags || []), "auto-observed"])],
    }, false);

    s.log(`[code-buddy] 🔍 Observer: ${result.message} (from ${buf.length} observations)`);
}
