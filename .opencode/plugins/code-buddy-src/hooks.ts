/**
 * All event hooks for Code Buddy:
 *  - event (file.edited, session.idle)
 *  - tool.execute.before (env protection)
 *  - tool.execute.after (observer buffer)
 *  - experimental.session.compacting (context injection)
 */

import * as fs from "node:fs";
import type { MemoryType, ErrorType, Observation } from "./types";
import { MEMORY_TYPE_CATEGORY, VALID_MEMORY_TYPES } from "./types";
import { generateId, formatTime, nowTimestamp, searchText, calculateSimilarity, calculateGuideRelevance } from "./helpers";
import { detectSessionType, saveMemoryWithSyncDedup } from "./dedup";
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
    // Track flush state: "idle" → "started" → "completed"
    let flushState: "idle" | "started" | "completed" = "idle";
    // Track whether we've injected relevant guides yet this session
    let guidesInjected = false;
    let guideMatchAttempts = 0;
    const MAX_GUIDE_MATCH_ATTEMPTS = 3;

    const flushObservations = async (reason: string) => {
        if (flushState !== "idle" || s.observationBuffer.length === 0) return;
        flushState = "started";
        s.log(`[code-buddy] 📤 Flushing observations (${reason}, ${s.observationBuffer.length} buffered)`);
        try {
            await handleSessionIdle(s);
            flushState = "completed";
            s.log(`[code-buddy] ✅ Async flush completed (${reason})`);
        } catch (err) {
            s.log(`[code-buddy] ❌ Async flush failed (${reason}):`, err);
            // Fall back to sync save so we don't lose data
            try { flushObservationsSync(s); } catch { /* best effort */ }
            flushState = "completed";
        }
    };

    // Safety net: flush on process exit (covers `opencode run` where
    // session.idle async work may not complete before process terminates)
    const onExit = () => {
        if (flushState === "completed") return; // async flush finished — nothing to do
        if (s.observationBuffer.length < s.config.hooks.observeMinActions) return;

        s.log(`[code-buddy] 📤 Process exiting (flushState=${flushState}) — sync saving ${s.observationBuffer.length} observations`);
        try {
            flushObservationsSync(s);
        } catch (err) {
            s.log("[code-buddy] Sync flush error:", err);
        }
    };
    process.on("beforeExit", onExit);
    process.on("exit", onExit);

    return {
        // ---- event: session lifecycle ----
        event: async ({ event }: { event: { type: string; properties?: Record<string, unknown> } }) => {
            if (event.type === "session.idle") {
                flushState = "idle"; // reset for next idle cycle
                await flushObservations("session.idle");
            }
            // Also flush when session ends (covers `opencode run`)
            if (event.type === "session.deleted") {
                await flushObservations("session.deleted");
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
        "tool.execute.after": async (input: { tool: string; args?: any }, output: { title?: string; output: string; metadata: any }) => {
            if (!s.config.hooks.autoObserve) return;

            const ignoreList = s.config.hooks.observeIgnoreTools || [];
            if (input.tool.startsWith("buddy_") || ignoreList.includes(input.tool)) return;

            const outputStr = typeof output.output === "string" ? output.output : "";

            const errorPatterns = /\b(error|Error|ERROR|failed|FAILED|FAIL|exception|Exception|panic|fatal|Fatal|ENOENT|EACCES|TypeError|ReferenceError|SyntaxError)\b/;
            const hasError = s.config.hooks.autoErrorDetect && errorPatterns.test(outputStr);

            const meta = output.metadata || {};
            const inputArgs = input.args || {};

            // Extract file path from multiple sources (metadata, input args, title)
            let fileEdited = (meta.filePath || meta.path || meta.file
                || inputArgs.filePath || inputArgs.file_path || inputArgs.path) as string | undefined;

            // Also try to extract from the title (e.g. "Write index.html", "Edit src/foo.ts")
            if (!fileEdited && output.title) {
                const titleMatch = output.title.match(/(?:Write|Edit|Create|Read)\s+(.+)/i);
                if (titleMatch) fileEdited = titleMatch[1].trim();
            }

            const isWriteAction = isWriteTool(input.tool) || !!fileEdited;

            // Capture more context for write/edit operations (code content is the valuable part)
            const resultLimit = isWriteAction ? 800 : 300;

            s.pushObservation({
                timestamp: nowTimestamp(),
                tool: input.tool,
                args: { ...meta, ...inputArgs },
                result: outputStr.substring(0, resultLimit),
                hasError,
                fileEdited,
                isWriteAction,
            });

            s.log(`[code-buddy] 👁️ Observed: ${input.tool}${fileEdited ? ` → ${fileEdited}` : ""}${isWriteAction ? " [write]" : ""} (title: ${output.title || "none"})`);

            // Inject relevant project guides on write actions.
            // Retry up to MAX_GUIDE_MATCH_ATTEMPTS times — the first write may be a config
            // file with poor context, so allow later, more informative writes to match.
            if (!guidesInjected && isWriteAction && s.memories.length > 0 && guideMatchAttempts < MAX_GUIDE_MATCH_ATTEMPTS) {
                guideMatchAttempts++;

                // Extract key identifiers from the file content for search
                const fileContent = String(inputArgs.content || "");
                const searchParts: string[] = [];

                // Extract HTML <title>
                const titleMatch = fileContent.match(/<title>(.+?)<\/title>/i);
                if (titleMatch) searchParts.push(titleMatch[1]);

                // Extract file name
                if (fileEdited) searchParts.push(fileEdited.split("/").pop() || "");

                // Extract function names (key identifiers)
                const funcNames = fileContent.match(/function\s+(\w+)/g);
                if (funcNames) searchParts.push(...funcNames.slice(0, 8).map((f) => f.replace("function ", "")));

                // Extract key game/app terms from title and output
                if (output.title) searchParts.push(output.title);
                if (inputArgs.command) searchParts.push(String(inputArgs.command));

                const searchCtx = searchParts.join(" ");
                s.log(`[code-buddy] 📚 Searching ${s.memories.length} memories for guides (attempt ${guideMatchAttempts}/${MAX_GUIDE_MATCH_ATTEMPTS}, context: "${searchCtx.substring(0, 80)}")`);

                // Use overlap coefficient for guide discovery — handles asymmetric lengths
                // (short search query vs long memory content) much better than Jaccard.
                const guides = s.memories
                    .map((m) => ({
                        memory: m,
                        score: calculateGuideRelevance(searchCtx, `${m.title} ${m.content}`),
                    }))
                    .filter((r) => r.score >= 0.15)
                    .sort((a, b) => b.score - a.score)
                    .slice(0, 2)
                    .map((r) => r.memory);

                s.log(`[code-buddy] 📚 Found ${guides.length} matching guide(s)`);

                if (guides.length > 0) {
                    guidesInjected = true;
                    let guideBlock = "\n\n---\n📚 **Relevant project guides from memory:**\n";
                    for (const g of guides) {
                        guideBlock += `\n### ${g.title}\n${g.content.substring(0, 800)}\n`;
                    }
                    guideBlock += "\n---";
                    output.output += guideBlock;
                    s.log(`[code-buddy] 📚 Injected ${guides.length} relevant guide(s) into tool output`);
                }
            }
        },

        // ---- session.compacting: inject memories/mistakes/entities into context ----
        "experimental.session.compacting": async (_input: unknown, output: { context: string[] }) => {
            if (!s.config.hooks.compactionContext) return;

            const recentMemories = [...s.memories].sort((a, b) => b.timestamp.localeCompare(a.timestamp)).slice(0, 5);
            const recentMistakes = [...s.mistakes].sort((a, b) => b.timestamp.localeCompare(a.timestamp)).slice(0, 3);
            const topEntities = s.entities.slice(0, 5);

            let block = "## Code Buddy Context (Auto-Injected)\n\n";

            if (recentMemories.length > 0) {
                block += "### Project Guides & Memories\n";
                for (const m of recentMemories) {
                    block += `\n#### [${m.type}] ${m.title}\n${m.content.substring(0, 500)}\n`;
                }
                block += "\n";
            }
            if (recentMistakes.length > 0) {
                block += "### Known Issues (Avoid Repeating)\n";
                block += recentMistakes.map((m) => `- ⚠️ ${m.action} → Solution: ${m.correctMethod.substring(0, 200)}`).join("\n");
                block += "\n\n";
            }
            if (topEntities.length > 0) {
                block += "### Key Entities\n";
                block += topEntities.map((e) => `- ${e.name} (${e.type})`).join("\n");
                block += "\n\n";
            }

            block += "Use `buddy_remember(query)` to search for more details.";
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

        const result = await addMemoryWithDedup(s, {
            type: entry.type,
            category: MEMORY_TYPE_CATEGORY[entry.type],
            title: entry.title,
            content: entry.summary,
            tags: [...new Set([...(entry.tags || []), "auto-observed", `auto-${entry.category}`])],
        }, false);

        s.log(`[code-buddy] 📝 Dedup result: ${result.action} — ${result.message}`);
        if (result.action === "created" || result.action === "merged") savedCount++;

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

// ---- Synchronous fallback flush for process exit ----

/**
 * Synchronous best-effort flush using rule-based classification only (no AI).
 * Used in process exit handlers where async operations cannot complete.
 *
 * Reads created/edited files from disk to extract a structured project guide
 * that can help an AI agent recreate or extend the project later.
 */
function flushObservationsSync(s: PluginState): void {
    const buf = s.observationBuffer;
    if (buf.length < s.config.hooks.observeMinActions) return;

    // Check requireEditForRecord gate
    if (s.config.hooks.requireEditForRecord) {
        const hasWriteAction = buf.some((o) => o.isWriteAction);
        const hasErrors = buf.some((o) => o.hasError);
        if (!hasWriteAction && !hasErrors) return;
    }

    const editedFiles = [...new Set(buf.filter((o) => o.fileEdited).map((o) => o.fileEdited as string))];
    if (editedFiles.length === 0) return;

    // Detect session type: debug/fix vs enhance vs build/create
    const sessionType = detectSessionType(buf);

    if (sessionType === "debug") {
        flushDebugSession(s, buf, editedFiles);
    } else if (sessionType === "enhance") {
        flushEnhanceSession(s, buf, editedFiles);
    } else {
        flushBuildSession(s, buf, editedFiles);
    }
}

/** Flush a debug/fix session — extract diffs, symptoms, and fixes. */
function flushDebugSession(s: PluginState, buf: Observation[], editedFiles: string[]): void {
    const fileNames = editedFiles.map((f) => f.split("/").pop() || f);
    const projectName = extractProjectName(buf, editedFiles);

    // Extract diffs from edit observations
    const diffs: string[] = [];
    for (const o of buf) {
        if (!(o.tool === "edit" || o.tool.toLowerCase().includes("edit"))) continue;

        const fileName = o.fileEdited ? (o.fileEdited.split("/").pop() || "") : "";
        let oldStr = "";
        let newStr = "";

        // Primary: extract from input args (old_string / new_string)
        if (o.args) {
            oldStr = (o.args.old_string || o.args.oldString || o.args.old || "") as string;
            newStr = (o.args.new_string || o.args.newString || o.args.new || "") as string;
        }

        // Fallback: parse unified diff from result
        if (!oldStr && !newStr && o.result) {
            const diffLines = o.result.split("\n");
            const removals: string[] = [];
            const additions: string[] = [];
            for (const line of diffLines) {
                if (line.startsWith("-") && !line.startsWith("---")) {
                    const cleaned = line.substring(1).trim();
                    if (cleaned && !cleaned.startsWith("@@")) removals.push(cleaned);
                }
                if (line.startsWith("+") && !line.startsWith("+++")) {
                    const cleaned = line.substring(1).trim();
                    if (cleaned && !cleaned.startsWith("@@")) additions.push(cleaned);
                }
            }
            oldStr = removals.join("\n");
            newStr = additions.join("\n");
        }

        if (oldStr || newStr) {
            const diffEntry: string[] = [];
            if (fileName) diffEntry.push(`File: ${fileName}`);
            if (oldStr) diffEntry.push(`Before: ${oldStr.substring(0, 200).trim()}`);
            if (newStr) diffEntry.push(`After: ${newStr.substring(0, 200).trim()}`);
            diffs.push(diffEntry.join("\n"));
        }
    }

    // Extract context from read observations (what was investigated)
    const investigated: string[] = [];
    for (const o of buf) {
        if (o.tool === "read" || o.tool.toLowerCase().includes("read")) {
            const file = o.fileEdited ? (o.fileEdited.split("/").pop() || "") : "";
            if (file) investigated.push(file);
        }
    }

    // Build the bugfix guide
    const title = projectName
        ? `Bugfix: ${projectName} (${fileNames.join(", ")})`.substring(0, 60)
        : `Bugfix: ${fileNames.join(", ")}`.substring(0, 60);

    const sections: string[] = [
        `## Bugfix: ${projectName || fileNames.join(", ")}`,
        `Files changed: ${editedFiles.join(", ")}`,
    ];

    if (investigated.length > 0) {
        sections.push(`Files investigated: ${[...new Set(investigated)].join(", ")}`);
    }

    if (diffs.length > 0) {
        sections.push("", "### Changes");
        for (const diff of diffs.slice(0, 5)) {
            sections.push(diff);
            sections.push("");
        }
    }

    // Also include current file analysis for context
    for (const filePath of editedFiles.slice(0, 2)) {
        try {
            const content = fs.readFileSync(filePath, "utf-8");
            const analysis = analyzeFileContent(filePath, content);
            if (analysis.summary) sections.push(analysis.summary);
        } catch { /* file may not exist */ }
    }

    const guide = sections.join("\n").substring(0, 2000);
    const tags = [...new Set([...inferTags(buf, editedFiles), "bugfix", "debugging"])].slice(0, 8);

    const saved = saveMemoryWithSyncDedup(s, {
        id: generateId("mem"),
        type: "bugfix" as MemoryType,
        category: "solution",
        title,
        content: guide,
        tags: [...new Set([...tags, "auto-observed", "bugfix-guide"])],
        timestamp: nowTimestamp(),
    } as MemoryEntry);

    s.log(`[code-buddy] 📤 Sync flush: saved bugfix guide "${saved.title}"`);
}

/** Flush an enhancement session — extract new features added to existing project. */
function flushEnhanceSession(s: PluginState, buf: Observation[], editedFiles: string[]): void {
    const fileNames = editedFiles.map((f) => f.split("/").pop() || f);
    const projectName = extractProjectName(buf, editedFiles);

    // Extract diffs from edit observations — focus on what was ADDED
    const features: string[] = [];
    const diffs: string[] = [];
    const newFunctionNames: string[] = [];
    const newCSSProps: string[] = [];
    const newHTMLElements: string[] = [];

    for (const o of buf) {
        if (!(o.tool === "edit" || o.tool.toLowerCase().includes("edit"))) continue;

        const fileName = o.fileEdited ? (o.fileEdited.split("/").pop() || "") : "";
        const oldStr = (o.args?.old_string || o.args?.oldString || o.args?.old || "") as string;
        const newStr = (o.args?.new_string || o.args?.newString || o.args?.new || "") as string;

        if (!newStr) continue;

        // Record the diff
        const diffEntry: string[] = [];
        if (fileName) diffEntry.push(`File: ${fileName}`);
        if (oldStr) diffEntry.push(`Before: ${oldStr.substring(0, 150).trim()}`);
        diffEntry.push(`After: ${newStr.substring(0, 200).trim()}`);
        diffs.push(diffEntry.join("\n"));

        // Detect new functions added
        const newFuncs = newStr.match(/function\s+(\w+)/g) || [];
        const oldFuncs = new Set((oldStr.match(/function\s+(\w+)/g) || []).map((f) => f.replace("function ", "")));
        for (const f of newFuncs) {
            const name = f.replace("function ", "");
            if (!oldFuncs.has(name)) newFunctionNames.push(name);
        }

        // Detect new arrow functions
        const newArrows = newStr.match(/(?:const|let)\s+(\w+)\s*=\s*(?:\([^)]*\)|[\w]+)\s*=>/g) || [];
        const oldArrows = new Set((oldStr.match(/(?:const|let)\s+(\w+)\s*=\s*(?:\([^)]*\)|[\w]+)\s*=>/g) || [])
            .map((f) => f.match(/(?:const|let)\s+(\w+)/)?.[1] || ""));
        for (const f of newArrows) {
            const name = f.match(/(?:const|let)\s+(\w+)/)?.[1] || "";
            if (name && !oldArrows.has(name)) newFunctionNames.push(name);
        }

        // Detect new HTML elements
        const newElems = newStr.match(/<(\w+)[\s>]/g) || [];
        const oldElems = new Set((oldStr.match(/<(\w+)[\s>]/g) || []).map((e) => e));
        for (const e of newElems) {
            if (!oldElems.has(e)) newHTMLElements.push(e.replace(/<|[\s>]/g, ""));
        }

        // Detect new CSS properties/features
        if (/text-shadow|box-shadow|animation|transition|transform/i.test(newStr) &&
            !/text-shadow|box-shadow|animation|transition|transform/i.test(oldStr)) {
            newCSSProps.push("visual effects");
        }
        if (/localStorage/i.test(newStr) && !/localStorage/i.test(oldStr)) {
            features.push("localStorage persistence");
        }
        if (/addEventListener/i.test(newStr) && !/addEventListener/i.test(oldStr)) {
            const eventMatch = newStr.match(/addEventListener\s*\(\s*['"](\w+)['"]/);
            if (eventMatch) features.push(`${eventMatch[1]} event handler`);
        }
    }

    // Build the enhancement guide
    const title = projectName
        ? `Enhancement: ${projectName} (${fileNames.join(", ")})`.substring(0, 60)
        : `Enhancement: ${fileNames.join(", ")}`.substring(0, 60);

    const sections: string[] = [
        `## Enhancement: ${projectName || fileNames.join(", ")}`,
        `Files modified: ${editedFiles.join(", ")}`,
    ];

    if (newFunctionNames.length > 0) {
        sections.push(`New functions: ${[...new Set(newFunctionNames)].join(", ")}`);
    }
    if (newHTMLElements.length > 0) {
        const unique = [...new Set(newHTMLElements)];
        sections.push(`New HTML elements: ${unique.join(", ")}`);
    }
    if (features.length > 0) {
        sections.push(`Features added: ${[...new Set(features)].join(", ")}`);
    }
    if (newCSSProps.length > 0) {
        sections.push(`CSS additions: ${[...new Set(newCSSProps)].join(", ")}`);
    }

    if (diffs.length > 0) {
        sections.push("", "### Changes");
        for (const diff of diffs.slice(0, 8)) {
            sections.push(diff);
            sections.push("");
        }
    }

    // Include current file analysis for full context
    for (const filePath of editedFiles.slice(0, 2)) {
        try {
            const content = fs.readFileSync(filePath, "utf-8");
            const analysis = analyzeFileContent(filePath, content);
            if (analysis.summary) sections.push(analysis.summary);
        } catch { /* file may not exist */ }
    }

    const guide = sections.join("\n").substring(0, 2000);
    const tags = [...new Set([...inferTags(buf, editedFiles), "enhancement"])].slice(0, 8);

    const saved = saveMemoryWithSyncDedup(s, {
        id: generateId("mem"),
        type: "feature" as MemoryType,
        category: "knowledge",
        title,
        content: guide,
        tags: [...new Set([...tags, "auto-observed", "enhancement-guide"])],
        timestamp: nowTimestamp(),
    } as MemoryEntry);

    s.log(`[code-buddy] 📤 Sync flush: saved enhancement guide "${saved.title}"`);
}

/** Flush a build/create session — extract project structure and tech details. */
function flushBuildSession(s: PluginState, buf: Observation[], editedFiles: string[]): void {
    // Read actual file contents from disk to extract knowledge
    const fileAnalyses: string[] = [];
    const allTags: string[] = [];

    for (const filePath of editedFiles) {
        try {
            const content = fs.readFileSync(filePath, "utf-8");
            const analysis = analyzeFileContent(filePath, content);
            if (analysis.summary) fileAnalyses.push(analysis.summary);
            allTags.push(...analysis.tags);
        } catch {
            // File might have been deleted or moved
        }
    }

    if (fileAnalyses.length === 0) return;

    // Build title from project context
    const projectName = extractProjectName(buf, editedFiles);
    const fileNames = editedFiles.map((f) => f.split("/").pop() || f);
    const title = projectName
        ? `${projectName} (${fileNames.join(", ")})`.substring(0, 60)
        : `Build ${fileNames.join(", ")}`.substring(0, 60);

    // Combine all file analyses into a structured guide
    const guide = [
        `## Project: ${projectName || fileNames.join(", ")}`,
        `Files: ${editedFiles.join(", ")}`,
        "",
        ...fileAnalyses,
    ].join("\n").substring(0, 2000);

    const tags = [...new Set([...inferTags(buf, editedFiles), ...allTags])].slice(0, 8);

    const saved = saveMemoryWithSyncDedup(s, {
        id: generateId("mem"),
        type: "feature" as MemoryType,
        category: "knowledge",
        title,
        content: guide,
        tags: [...new Set([...tags, "auto-observed", "project-guide"])],
        timestamp: nowTimestamp(),
    } as MemoryEntry);

    s.log(`[code-buddy] 📤 Sync flush: saved project guide "${saved.title}"`);
}

// ---- File analysis helpers for sync flush ----

/** Try to extract a human-readable project name from observations. */
function extractProjectName(buf: Observation[], editedFiles: string[]): string {
    // Check todo/task descriptions in observation results
    for (const o of buf) {
        if (!o.result) continue;
        // Look for task descriptions like "Build a Flappy Bird clone"
        const taskMatch = o.result.match(/(?:Build|Create|Implement|Make)\s+(?:a\s+)?(.{5,40?})(?:\s+in\s+|\s+clone|\s+game)/i);
        if (taskMatch) return taskMatch[1].trim();
    }

    // Try HTML <title> from files
    for (const f of editedFiles) {
        if (f.endsWith(".html")) {
            try {
                const content = fs.readFileSync(f, "utf-8").substring(0, 2000);
                const titleMatch = content.match(/<title>(.+?)<\/title>/i);
                if (titleMatch && titleMatch[1].length > 2) return titleMatch[1];
            } catch { /* ignore */ }
        }
    }

    return "";
}

/** Analyze a file's content and extract structured technical details. */
function analyzeFileContent(filePath: string, content: string): { summary: string; tags: string[] } {
    const ext = filePath.split(".").pop()?.toLowerCase() || "";
    const fileName = filePath.split("/").pop() || filePath;

    if (ext === "html") return analyzeHTML(fileName, content);
    if (ext === "css") return analyzeCSS(fileName, content);
    if (ext === "js" || ext === "ts") return analyzeJS(fileName, content);
    if (ext === "json") return analyzeJSON(fileName, content);
    if (ext === "md") return analyzeMD(fileName, content);

    return { summary: `File: ${fileName} (${content.length} bytes)`, tags: [] };
}

function analyzeHTML(fileName: string, content: string): { summary: string; tags: string[] } {
    const lines: string[] = [];
    const tags: string[] = ["html"];

    // Title
    const title = content.match(/<title>(.+?)<\/title>/i);
    if (title) lines.push(`Title: "${title[1]}"`);

    // Architecture: single-file or multi-file
    const hasInlineCSS = /<style[\s>]/i.test(content);
    const hasInlineJS = /<script[\s>]/i.test(content);
    const externalCSS = content.match(/href="([^"]+\.css)"/gi) || [];
    const externalJS = content.match(/src="([^"]+\.js)"/gi) || [];
    const arch: string[] = [];
    if (hasInlineCSS && hasInlineJS && externalCSS.length === 0 && externalJS.length === 0) {
        arch.push("Single-file (embedded CSS + JS)");
    } else {
        if (hasInlineCSS) arch.push("inline CSS");
        if (hasInlineJS) arch.push("inline JS");
        if (externalCSS.length > 0) arch.push(`external CSS: ${externalCSS.join(", ")}`);
        if (externalJS.length > 0) arch.push(`external JS: ${externalJS.join(", ")}`);
    }
    if (arch.length > 0) lines.push(`Architecture: ${arch.join(", ")}`);

    // Canvas
    const canvas = content.match(/<canvas[^>]*(?:width="(\d+)")[^>]*(?:height="(\d+)")?/i)
        || content.match(/<canvas[^>]*>/i);
    if (canvas) {
        tags.push("html-canvas");
        const w = canvas[1], h = canvas[2];
        lines.push(`Canvas: ${w && h ? `${w}x${h}` : "dynamic size"}`);
    }

    // Fonts
    const fonts = content.match(/family=([^"&]+)/g);
    if (fonts) {
        const fontNames = [...new Set(fonts.map((f) => decodeURIComponent(f.replace("family=", "")).replace(/\+/g, " ")))];
        lines.push(`Fonts: ${fontNames.join(", ")}`);
    }

    // Colors / theme
    const bgColors = content.match(/background(?:-color)?:\s*(#[0-9a-f]{3,8}|rgb[^;)]+)/gi) || [];
    const textColors = content.match(/(?:^|[\s;])color:\s*(#[0-9a-f]{3,8}|rgb[^;)]+)/gi) || [];
    const allColors = [...new Set([...bgColors, ...textColors].map((c) => {
        const m = c.match(/(#[0-9a-f]{3,8}|rgb[^;)]+\))/i);
        return m ? m[1] : "";
    }).filter(Boolean))];
    if (allColors.length > 0) lines.push(`Colors: ${allColors.slice(0, 6).join(", ")}`);

    // JS functions (key game/app logic)
    const funcs = content.match(/function\s+(\w+)/g) || [];
    const arrowFuncs = content.match(/(?:const|let)\s+(\w+)\s*=\s*(?:\([^)]*\)|[\w]+)\s*=>/g) || [];
    const allFuncs = [
        ...funcs.map((f) => f.replace("function ", "")),
        ...arrowFuncs.map((f) => f.match(/(?:const|let)\s+(\w+)/)?.[1] || ""),
    ].filter(Boolean);
    if (allFuncs.length > 0) {
        lines.push(`Key functions: ${allFuncs.slice(0, 12).join(", ")}`);
        tags.push("vanilla-js");
    }

    // Event listeners (controls)
    const events = content.match(/addEventListener\s*\(\s*['"](\w+)['"]/g) || [];
    const eventTypes = [...new Set(events.map((e) => e.match(/['"](\w+)['"]/)?.[1] || ""))].filter(Boolean);
    if (eventTypes.length > 0) lines.push(`Controls: ${eventTypes.join(", ")} events`);

    // requestAnimationFrame (game loop)
    if (/requestAnimationFrame/i.test(content)) {
        lines.push("Game loop: requestAnimationFrame");
        tags.push("game-loop");
    }

    // setInterval (alternative game loop)
    const intervals = content.match(/setInterval\s*\([^,]+,\s*(\d+)\)/g);
    if (intervals) lines.push(`Timer: setInterval (${intervals.length} timer(s))`);

    // Key game patterns
    if (/collision|collide|intersect|hitTest/i.test(content)) {
        lines.push("Collision detection: yes");
        tags.push("collision-detection");
    }
    if (/score/i.test(content)) tags.push("scoring");
    if (/gameOver|game.over|game_over/i.test(content)) tags.push("game-state");
    if (/localStorage/i.test(content)) tags.push("local-storage");

    // File size
    lines.push(`Total size: ${content.length} bytes, ~${content.split("\n").length} lines`);

    return {
        summary: `### ${fileName}\n${lines.join("\n")}`,
        tags: tags.slice(0, 5),
    };
}

function analyzeCSS(fileName: string, content: string): { summary: string; tags: string[] } {
    const lines: string[] = [];
    const tags: string[] = ["css"];

    const selectors = content.match(/[.#][\w-]+/g) || [];
    const uniqueSelectors = [...new Set(selectors)];
    if (uniqueSelectors.length > 0) lines.push(`Key selectors: ${uniqueSelectors.slice(0, 10).join(", ")}`);

    if (/display:\s*grid/i.test(content)) { lines.push("Layout: CSS Grid"); tags.push("css-grid"); }
    if (/display:\s*flex/i.test(content)) { lines.push("Layout: Flexbox"); tags.push("flexbox"); }
    if (/@keyframes/i.test(content)) { lines.push("Animations: CSS keyframes"); tags.push("css-animations"); }
    if (/@media/i.test(content)) lines.push("Responsive: media queries");
    if (/--[\w-]+:/i.test(content)) lines.push("CSS variables: yes");

    return { summary: `### ${fileName}\n${lines.join("\n")}`, tags };
}

function analyzeJS(fileName: string, content: string): { summary: string; tags: string[] } {
    const lines: string[] = [];
    const tags: string[] = ["javascript"];

    const funcs = content.match(/(?:function\s+(\w+)|(?:const|let)\s+(\w+)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[\w]+)\s*=>)/g) || [];
    if (funcs.length > 0) lines.push(`Functions: ${funcs.slice(0, 10).map((f) => f.match(/(\w+)/)?.[1]).filter(Boolean).join(", ")}`);

    const classes = content.match(/class\s+(\w+)/g) || [];
    if (classes.length > 0) {
        lines.push(`Classes: ${classes.map((c) => c.replace("class ", "")).join(", ")}`);
        tags.push("oop");
    }

    const imports = content.match(/import\s+.+from\s+['"]([^'"]+)['"]/g) || [];
    if (imports.length > 0) lines.push(`Imports: ${imports.slice(0, 5).join(", ")}`);

    return { summary: `### ${fileName}\n${lines.join("\n")}`, tags };
}

function analyzeJSON(fileName: string, content: string): { summary: string; tags: string[] } {
    try {
        const obj = JSON.parse(content);
        const keys = Object.keys(obj).slice(0, 8);
        const lines = [`Top-level keys: ${keys.join(", ")}`];
        if (obj.name) lines.push(`Name: ${obj.name}`);
        if (obj.dependencies) lines.push(`Dependencies: ${Object.keys(obj.dependencies).join(", ")}`);
        return { summary: `### ${fileName}\n${lines.join("\n")}`, tags: ["config"] };
    } catch {
        return { summary: `### ${fileName}\nJSON config file`, tags: ["config"] };
    }
}

function analyzeMD(fileName: string, content: string): { summary: string; tags: string[] } {
    const headings = content.match(/^#+\s+.+$/gm) || [];
    const lines = headings.length > 0
        ? [`Sections: ${headings.slice(0, 6).map((h) => h.replace(/^#+\s+/, "")).join(", ")}`]
        : [`Markdown doc (${content.split("\n").length} lines)`];
    return { summary: `### ${fileName}\n${lines.join("\n")}`, tags: ["docs"] };
}
