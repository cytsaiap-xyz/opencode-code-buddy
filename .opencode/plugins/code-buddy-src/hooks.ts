/**
 * All event hooks for Code Buddy:
 *  - event (file.edited, session.idle)
 *  - tool.execute.before (env protection)
 *  - tool.execute.after (observer buffer)
 *  - experimental.session.compacting (context injection)
 */

import * as fs from "node:fs";
import type { MemoryType, MemoryEntry, ErrorType, Observation } from "./types";
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
    if (readCount > writeCount * 2) return { intent: "exploration", type: "note" };

    // Distinguish building (creating new files) from refactoring (small edits across many files).
    // "Write" tools create/overwrite entire files; "Edit" tools make targeted changes.
    if (editedFiles.length >= 3) {
        const createCount = buf.filter((o) =>
            o.isWriteAction && /write|create/i.test(o.tool),
        ).length;
        const editCount = buf.filter((o) =>
            o.isWriteAction && /edit|replace|patch/i.test(o.tool),
        ).length;
        // If mostly creating files → building; if mostly editing → refactoring
        if (editCount > createCount) return { intent: "refactoring", type: "pattern" };
    }

    if (editedFiles.length > 0) return { intent: "task-execution", type: "feature" };
    return { intent: "task-execution", type: "note" };
}

/**
 * Build meaningful fallback entries from raw observation data.
 * Used when AI classification fails or no LLM is available.
 * Focuses on WHAT was accomplished, not tool/file inventory.
 */
function buildFallbackEntries(
    buf: Observation[],
    editedFiles: string[],
    hasErrors: boolean,
): AutoEntry[] {
    const entries: AutoEntry[] = [];
    const { intent, type } = classifyIntent(buf, editedFiles, hasErrors);

    const fileNames = editedFiles.map(shortFileName).filter(Boolean);
    let title: string;
    let summary: string;

    if (fileNames.length > 0) {
        const verb = intent === "debugging" ? "Fixed"
            : intent === "refactoring" ? "Refactored"
            : "Built";
        title = fileNames.length <= 2
            ? `${verb} ${fileNames.join(", ")}`
            : `${verb} ${fileNames.slice(0, 2).join(", ")} +${fileNames.length - 2} more`;

        // Try to build a summary from edit diffs — what actually changed
        const changeSummaries: string[] = [];
        for (const o of buf) {
            if (!o.isWriteAction || !o.args) continue;
            const newStr = (o.args.new_string || o.args.newString || o.args.content || "") as string;
            if (newStr && newStr.length > 20) {
                // Extract first meaningful line of the new content
                const firstLine = newStr.split("\n").find((l) => l.trim().length > 10);
                if (firstLine) changeSummaries.push(firstLine.trim().substring(0, 80));
            }
        }

        if (changeSummaries.length > 0) {
            summary = `Changes: ${changeSummaries.slice(0, 3).join("; ")}`;
        } else {
            // Fall back to bash command descriptions
            const cmds = buf
                .filter((o) => o.args?.command)
                .map((o) => String(o.args!.command).split("&&")[0].trim().substring(0, 60));
            summary = cmds.length > 0
                ? `Ran: ${cmds.slice(0, 3).join(", ")}`
                : `${verb} ${editedFiles.map((f) => f.split("/").pop()).join(", ")}`;
        }
    } else {
        // No file edits — describe from commands
        const cmds = buf
            .filter((o) => o.args?.command)
            .map((o) => String(o.args!.command).split("&&")[0].trim().substring(0, 60));
        if (cmds.length > 0) {
            title = cmds[0].length <= 60 ? cmds[0] : `${cmds[0].substring(0, 57)}...`;
            summary = cmds.slice(0, 3).join("; ");
        } else {
            title = "Session activity";
            summary = `${buf.length} operations performed`;
        }
    }

    if (title.length > 60) title = `${title.substring(0, 57)}...`;

    const tags = inferTags(buf, editedFiles);

    entries.push({
        category: intent === "debugging" ? "error" : "task",
        title,
        summary,
        type,
        tags,
    });

    // Separate error entry — focused on the symptom and what fixed it
    if (hasErrors && intent !== "debugging") {
        const errorObs = buf.filter((o) => o.hasError);

        // Extract actual error message, not tool description
        const errorMessages: string[] = [];
        for (const o of errorObs) {
            if (o.result) {
                const errorLine = o.result.split("\n").find((l) =>
                    /error|Error|ERROR|failed|TypeError|ReferenceError/i.test(l),
                );
                if (errorLine) errorMessages.push(errorLine.trim().substring(0, 120));
            }
        }

        const errorFile = errorObs[0]?.fileEdited
            ? shortFileName(errorObs[0].fileEdited)
            : "unknown";

        entries.push({
            category: "error",
            title: `Gotcha in ${errorFile}`.substring(0, 60),
            summary: errorMessages.length > 0
                ? `Error: ${errorMessages[0]}`
                : `Error encountered in ${errorFile} during ${intent}`,
            type: "bugfix",
            tags: [...inferTags(errorObs, editedFiles), "gotcha"],
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

    const prompt = `You are a knowledge extraction AI. Your job is to capture the **understanding** someone needs to continue working on this project — not an inventory of files/functions, but the mental model, decisions, gotchas, and conventions.

Observations:
${observationSummary}
${hasErrors ? "\n⚠️ Some observations contain errors." : ""}
${editedFiles.length > 0 ? `\n📝 Files edited: ${editedFiles.join(", ")}` : ""}

Extract knowledge that answers these questions for a future developer:

1. **Mental model** — How does the system work conceptually? What are the core data structures, how does state flow, what's the main algorithm? (e.g. "Snake is an array of {x,y} coords. Movement = unshift new head, pop tail. Growth = skip the pop.")
2. **Design decisions & rejected alternatives** — What was chosen and what was NOT chosen, and why? (e.g. "Used CSS grid instead of canvas because we need DOM click events on individual tiles")
3. **Gotchas & landmines** — What broke or would break if done wrong? (e.g. "Don't use setInterval for game loop — it drifts. Use requestAnimationFrame with delta time")
4. **Conventions established** — What patterns must future code follow to stay consistent? (e.g. "All coordinates are {col, row} not {x, y}. Colors are CSS variables in :root, never hardcoded.")
5. **Project status** — What works, what's not done, known bugs? (e.g. "Core gameplay works. NOT done: high score persistence, mobile touch. Known bug: food can spawn on snake body.")

Rules:
- Output 1-3 entries. Fewer is better. SKIP if the session is trivial (just reading files, no real work).
- Each entry must have: category, title (max 60 chars), summary (2-4 sentences of actual understanding), type, tags
- "category": "task" (what was built), "decision" (architecture/tech choice), "error" (bug + fix), or "pattern" (reusable approach)
- "type": "feature", "decision", "pattern", "bugfix", "lesson", or "note"
- "summary" MUST explain HOW things work and WHY they are that way — data structures, algorithms, state shape, control flow. NOT lists of function names, file sizes, CSS colors, or "updated the code."
- Tags must be domain-specific: "state-as-array", "grid-movement", "collision-detection", "event-driven", NOT generic like "code-change", "html", "javascript"
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

    const prompt = `You are a knowledge extraction AI. Capture the **understanding** a future developer needs to continue this project — the mental model, not an inventory.

Observations:
${observationSummary}

DO NOT list tools used, files edited, function names, or CSS colors. Instead, extract:

1. **Mental model** — How does the system work? Core data structures, state flow, main algorithm. (e.g. "Board is a 4x4 number matrix. Merging scans each row left-to-right, combining equal adjacent cells. Empty cells collapse by filtering zeros.")
2. **Design decisions** — What was chosen over alternatives, and why? (e.g. "CSS grid for the board because tiles need precise 2D positioning; canvas would lose DOM event handling on tiles")
3. **Gotchas** — What broke or would break? (e.g. "Must deep-copy board state before each move attempt, otherwise undo is impossible")
4. **Conventions** — Patterns future code must follow. (e.g. "Coordinates are always {col, row}. State updates go through dispatch(), never direct mutation.")
5. **Status** — What works, what's missing, known bugs.

Produce a single memory entry:
1. Summary must be 2-4 sentences explaining HOW things work and WHY — data structures, algorithms, state shape, control flow. NOT lists of function names or "made changes to files."
2. Type: "feature" (what was built), "decision" (architecture/tech choice), "pattern" (reusable approach), "bugfix", "lesson", or "note"
3. Title (max 60 chars): the conceptual knowledge, e.g. "Snake: array-based movement with unshift/pop"
4. Tags: 3-5 domain-specific tags like "state-as-array", "grid-movement", "bounding-box-collision". NOT generic like "html", "javascript", "code-change".

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

/** Flush a debug/fix session — extract what broke, why, and how it was fixed. */
function flushDebugSession(s: PluginState, buf: Observation[], editedFiles: string[]): void {
    const fileNames = editedFiles.map((f) => f.split("/").pop() || f);
    const projectName = extractProjectName(buf, editedFiles);

    // Extract diffs — the WHAT of the fix
    const fixes: string[] = [];
    for (const o of buf) {
        if (!(o.tool === "edit" || o.tool.toLowerCase().includes("edit"))) continue;

        const fileName = o.fileEdited ? (o.fileEdited.split("/").pop() || "") : "";
        let oldStr = "";
        let newStr = "";

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
            const fixEntry: string[] = [];
            if (fileName) fixEntry.push(`In ${fileName}:`);
            if (oldStr) fixEntry.push(`  Was: ${oldStr.substring(0, 150).trim()}`);
            if (newStr) fixEntry.push(`  Now: ${newStr.substring(0, 150).trim()}`);
            fixes.push(fixEntry.join("\n"));
        }
    }

    // Extract error messages — the SYMPTOM
    const errors: string[] = [];
    for (const o of buf) {
        if (o.hasError && o.result) {
            const errorLine = o.result.split("\n").find((l) =>
                /error|Error|ERROR|failed|FAILED|TypeError|ReferenceError|SyntaxError/i.test(l),
            );
            if (errorLine) errors.push(errorLine.trim().substring(0, 150));
        }
    }

    // Build the bugfix guide — focused on the gotcha/landmine
    const title = projectName
        ? `Gotcha: ${projectName} (${fileNames.join(", ")})`.substring(0, 60)
        : `Gotcha: ${fileNames.join(", ")}`.substring(0, 60);

    const sections: string[] = [
        `## Bugfix: ${projectName || fileNames.join(", ")}`,
    ];

    if (errors.length > 0) {
        sections.push("", "### Symptom");
        sections.push(...errors.slice(0, 3));
    }

    if (fixes.length > 0) {
        sections.push("", "### Fix");
        for (const fix of fixes.slice(0, 5)) {
            sections.push(fix);
        }
    }

    sections.push("", "### Prevention");
    sections.push("Watch for this pattern in future sessions.");

    const guide = sections.join("\n").substring(0, 2000);
    const tags = [...new Set([...inferTags(buf, editedFiles), "gotcha", "debugging"])].slice(0, 8);

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

/** Flush an enhancement session — capture what capability was added and how it integrates. */
function flushEnhanceSession(s: PluginState, buf: Observation[], editedFiles: string[]): void {
    const fileNames = editedFiles.map((f) => f.split("/").pop() || f);
    const projectName = extractProjectName(buf, editedFiles);

    // Extract diffs — focus on understanding WHAT capability was added
    const changes: string[] = [];
    const capabilities: string[] = [];

    for (const o of buf) {
        if (!(o.tool === "edit" || o.tool.toLowerCase().includes("edit"))) continue;

        const fileName = o.fileEdited ? (o.fileEdited.split("/").pop() || "") : "";
        const oldStr = (o.args?.old_string || o.args?.oldString || o.args?.old || "") as string;
        const newStr = (o.args?.new_string || o.args?.newString || o.args?.new || "") as string;

        if (!newStr) continue;

        // Record the change with context
        const changeEntry: string[] = [];
        if (fileName) changeEntry.push(`In ${fileName}:`);
        if (oldStr) changeEntry.push(`  Was: ${oldStr.substring(0, 120).trim()}`);
        changeEntry.push(`  Now: ${newStr.substring(0, 150).trim()}`);
        changes.push(changeEntry.join("\n"));

        // Detect what KIND of capability was added (not just names)
        if (/localStorage/i.test(newStr) && !/localStorage/i.test(oldStr)) {
            capabilities.push("data persistence via localStorage");
        }
        if (/addEventListener/i.test(newStr) && !/addEventListener/i.test(oldStr)) {
            const eventMatch = newStr.match(/addEventListener\s*\(\s*['"](\w+)['"]/);
            if (eventMatch) capabilities.push(`${eventMatch[1]} input handling`);
        }
        if (/animation|transition|@keyframes/i.test(newStr) && !/animation|transition|@keyframes/i.test(oldStr)) {
            capabilities.push("visual animations");
        }
        if (/fetch\s*\(|axios|XMLHttpRequest/i.test(newStr) && !/fetch\s*\(|axios|XMLHttpRequest/i.test(oldStr)) {
            capabilities.push("external API integration");
        }
    }

    const title = projectName
        ? `Enhancement: ${projectName}`.substring(0, 60)
        : `Enhancement: ${fileNames.join(", ")}`.substring(0, 60);

    const sections: string[] = [
        `## Enhancement: ${projectName || fileNames.join(", ")}`,
    ];

    if (capabilities.length > 0) {
        sections.push("", "### What was added");
        sections.push([...new Set(capabilities)].map((c) => `- ${c}`).join("\n"));
    }

    if (changes.length > 0) {
        sections.push("", "### How it was implemented");
        for (const change of changes.slice(0, 6)) {
            sections.push(change);
        }
    }

    // Add understanding of current system state from file analysis
    for (const filePath of editedFiles.slice(0, 2)) {
        try {
            const content = fs.readFileSync(filePath, "utf-8");
            const analysis = analyzeFileContent(filePath, content);
            if (analysis.summary) sections.push("", analysis.summary);
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

/** Flush a build/create session — extract how the project works, not just what files exist. */
function flushBuildSession(s: PluginState, buf: Observation[], editedFiles: string[]): void {
    const projectName = extractProjectName(buf, editedFiles);
    const fileNames = editedFiles.map((f) => f.split("/").pop() || f);

    // Read files and extract understanding
    const analyses: string[] = [];
    const allTags: string[] = [];

    for (const filePath of editedFiles) {
        try {
            const content = fs.readFileSync(filePath, "utf-8");
            const analysis = analyzeFileContent(filePath, content);
            if (analysis.summary) analyses.push(analysis.summary);
            allTags.push(...analysis.tags);
        } catch {
            // File might have been deleted or moved
        }
    }

    if (analyses.length === 0) return;

    const title = projectName
        ? `${projectName}: how it works`.substring(0, 60)
        : `${fileNames.join(", ")}: how it works`.substring(0, 60);

    // Build a guide focused on understanding, not inventory
    const sections: string[] = [
        `## ${projectName || fileNames.join(", ")}`,
    ];

    // Architecture decision
    if (editedFiles.length === 1 && editedFiles[0].endsWith(".html")) {
        sections.push("Architecture: Single-file app (all code in one HTML file)");
    } else if (editedFiles.length > 1) {
        sections.push(`Architecture: ${editedFiles.length} files (${fileNames.join(", ")})`);
    }

    // Add file-level understanding
    sections.push("", ...analyses);

    // Extract conventions from bash commands (test scripts, build tools, etc.)
    const bashCommands = buf
        .filter((o) => o.tool.toLowerCase().includes("bash") && o.args?.command)
        .map((o) => String(o.args!.command));

    if (bashCommands.length > 0) {
        const devCmds = bashCommands.filter((c) =>
            /npm|yarn|pnpm|test|build|serve|start|lint/i.test(c),
        );
        if (devCmds.length > 0) {
            sections.push("", "### Dev workflow");
            sections.push(...devCmds.slice(0, 3).map((c) => `- \`${c.substring(0, 80)}\``));
        }
    }

    const guide = sections.join("\n").substring(0, 2000);
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

/**
 * Analyze a file's content and extract **understanding** — how it works,
 * what patterns it uses, what data structures drive it — NOT an inventory
 * of names, colors, or byte counts.
 */
function analyzeFileContent(filePath: string, content: string): { summary: string; tags: string[] } {
    const ext = filePath.split(".").pop()?.toLowerCase() || "";
    const fileName = filePath.split("/").pop() || filePath;

    if (ext === "html") return analyzeHTML(fileName, content);
    if (ext === "css") return analyzeCSS(fileName, content);
    if (ext === "js" || ext === "ts") return analyzeJS(fileName, content);
    if (ext === "json") return analyzeJSON(fileName, content);
    if (ext === "md") return analyzeMD(fileName, content);

    return { summary: "", tags: [] };
}

function analyzeHTML(fileName: string, content: string): { summary: string; tags: string[] } {
    const lines: string[] = [];
    const tags: string[] = [];

    // Project identity
    const title = content.match(/<title>(.+?)<\/title>/i);
    if (title) lines.push(`Project: "${title[1]}"`);

    // Architecture decision — single-file vs multi-file (this is a design decision worth recording)
    const hasInlineCSS = /<style[\s>]/i.test(content);
    const hasInlineJS = /<script[\s>]/i.test(content);
    const externalCSS = content.match(/href="([^"]+\.css)"/gi) || [];
    const externalJS = content.match(/src="([^"]+\.js)"/gi) || [];
    if (hasInlineCSS && hasInlineJS && externalCSS.length === 0 && externalJS.length === 0) {
        lines.push("Architecture: Single-file app (all CSS + JS embedded in HTML)");
        tags.push("single-file-app");
    }

    // Core data structures — look for state initialization patterns
    const statePatterns = content.match(/(?:let|const|var)\s+(\w+)\s*=\s*(\[[\s\S]{0,100}?\]|\{[\s\S]{0,100}?\}|new\s+\w+[\s\S]{0,60}?[;)\n])/g) || [];
    const meaningfulState = statePatterns.filter((s) => {
        // Skip trivial assignments like `const x = {}`
        return s.length > 20 && !/=\s*\{\s*\}/.test(s) && !/=\s*\[\s*\]/.test(s);
    });
    if (meaningfulState.length > 0) {
        const stateDesc = meaningfulState.slice(0, 3).map((s) => s.substring(0, 80).trim()).join("; ");
        lines.push(`Core state: ${stateDesc}`);
        tags.push("state-management");
    }

    // Game loop / update pattern — HOW the system updates, not just that it exists
    if (/requestAnimationFrame/i.test(content)) {
        const deltaTime = /delta|dt|elapsed|lastTime|previousTime/i.test(content);
        lines.push(`Update loop: requestAnimationFrame${deltaTime ? " with delta-time" : " (fixed frame)"}`);
        tags.push("game-loop");
    } else {
        const intervals = content.match(/setInterval\s*\([^,]+,\s*(\d+)\)/);
        if (intervals) {
            lines.push(`Update loop: setInterval at ${intervals[1]}ms`);
            tags.push("timer-based");
        }
    }

    // Movement / physics model
    if (/velocity|speed|acceleration|dx|dy/i.test(content)) {
        const gravity = /gravity|gravit/i.test(content);
        lines.push(`Physics: velocity-based movement${gravity ? " with gravity" : ""}`);
        tags.push("physics");
    }

    // Collision approach — HOW collisions work
    if (/collision|collide|intersect|hitTest|overlap/i.test(content)) {
        const bbox = /getBoundingClientRect|\.left|\.right|\.top|\.bottom|\.width|\.height/i.test(content);
        const pixel = /getImageData|pixel/i.test(content);
        const grid = /grid|cell|tile|board\[/i.test(content);
        const approach = bbox ? "bounding-box" : pixel ? "pixel-perfect" : grid ? "grid/cell-based" : "custom";
        lines.push(`Collision: ${approach} detection`);
        tags.push("collision-detection");
    }

    // Input handling — what controls exist and how they map
    const keyHandler = content.match(/addEventListener\s*\(\s*['"]key(down|up|press)['"]/gi);
    const mouseHandler = content.match(/addEventListener\s*\(\s*['"](click|mouse\w+|touch\w+)['"]/gi);
    const controls: string[] = [];
    if (keyHandler) controls.push("keyboard");
    if (mouseHandler) controls.push("mouse/touch");
    if (/ArrowLeft|ArrowRight|ArrowUp|ArrowDown/i.test(content)) controls.push("arrow keys");
    if (/['"](w|a|s|d)['"]/i.test(content) && /key/i.test(content)) controls.push("WASD");
    if (controls.length > 0) lines.push(`Controls: ${controls.join(", ")}`);

    // Canvas usage — dimensions matter for understanding coordinate system
    const canvas = content.match(/<canvas[^>]*(?:width="(\d+)")[^>]*(?:height="(\d+)")?/i);
    if (canvas && canvas[1] && canvas[2]) {
        lines.push(`Canvas: ${canvas[1]}x${canvas[2]} coordinate space`);
        tags.push("canvas-rendering");
    } else if (/<canvas/i.test(content)) {
        tags.push("canvas-rendering");
    }

    // Persistence — what gets saved and how
    if (/localStorage/i.test(content)) {
        const keys = content.match(/localStorage\.\w+Item\s*\(\s*['"]([^'"]+)['"]/g) || [];
        const keyNames = [...new Set(keys.map((k) => k.match(/['"]([^'"]+)['"]/)?.[1] || ""))].filter(Boolean);
        lines.push(`Persistence: localStorage${keyNames.length > 0 ? ` (keys: ${keyNames.join(", ")})` : ""}`);
    }

    // Rendering approach — DOM vs canvas
    if (/<canvas/i.test(content) && /\.getContext|ctx\./i.test(content)) {
        lines.push("Rendering: canvas 2D context (direct draw calls)");
    } else if (/innerHTML|appendChild|createElement|\.textContent/i.test(content)) {
        lines.push("Rendering: DOM manipulation");
        tags.push("dom-rendering");
    }

    if (lines.length === 0) return { summary: "", tags: [] };

    return {
        summary: `### ${fileName}\n${lines.join("\n")}`,
        tags: tags.slice(0, 5),
    };
}

function analyzeCSS(fileName: string, content: string): { summary: string; tags: string[] } {
    const lines: string[] = [];
    const tags: string[] = [];

    // Layout strategy — the architectural decision, not a list of selectors
    const hasGrid = /display:\s*grid/i.test(content);
    const hasFlex = /display:\s*flex/i.test(content);
    if (hasGrid && hasFlex) {
        lines.push("Layout: CSS Grid for main structure, Flexbox for component alignment");
        tags.push("css-grid", "flexbox");
    } else if (hasGrid) {
        // Extract grid template to understand the board/layout shape
        const template = content.match(/grid-template-columns:\s*([^;]+)/i);
        if (template) lines.push(`Layout: CSS Grid (${template[1].trim().substring(0, 60)})`);
        else lines.push("Layout: CSS Grid");
        tags.push("css-grid");
    } else if (hasFlex) {
        lines.push("Layout: Flexbox");
        tags.push("flexbox");
    }

    // Animation approach — what animates and how
    const keyframes = content.match(/@keyframes\s+(\w[\w-]*)/g) || [];
    if (keyframes.length > 0) {
        const names = keyframes.map((k) => k.replace("@keyframes ", ""));
        lines.push(`Animations: ${names.join(", ")} (CSS keyframes)`);
        tags.push("css-animations");
    }
    const transitions = content.match(/transition:\s*([^;]+)/gi) || [];
    if (transitions.length > 0 && keyframes.length === 0) {
        lines.push("Animations: CSS transitions");
    }

    // Theming approach — CSS variables indicate a theming system
    const vars = content.match(/--[\w-]+:/g) || [];
    if (vars.length >= 3) {
        const varNames = vars.slice(0, 5).map((v) => v.replace(":", ""));
        lines.push(`Theming: CSS custom properties (${varNames.join(", ")})`);
        tags.push("css-variables");
    }

    // Responsive design
    const mediaQueries = content.match(/@media[^{]+/g) || [];
    if (mediaQueries.length > 0) {
        lines.push(`Responsive: ${mediaQueries.length} breakpoint(s)`);
    }

    if (lines.length === 0) return { summary: "", tags: [] };

    return { summary: `### ${fileName}\n${lines.join("\n")}`, tags };
}

function analyzeJS(fileName: string, content: string): { summary: string; tags: string[] } {
    const lines: string[] = [];
    const tags: string[] = [];

    // Architecture pattern — classes vs functional, modules vs scripts
    const classes = content.match(/class\s+(\w+)/g) || [];
    const imports = content.match(/import\s+.+from\s+['"]([^'"]+)['"]/g) || [];
    if (classes.length > 0) {
        const names = classes.map((c) => c.replace("class ", ""));
        lines.push(`Architecture: class-based (${names.join(", ")})`);
        tags.push("class-based");
    }
    if (imports.length > 0) {
        const externals = imports
            .map((i) => i.match(/from\s+['"]([^'"]+)['"]/)?.[1] || "")
            .filter((m) => m && !m.startsWith("."));
        if (externals.length > 0) lines.push(`Dependencies: ${externals.join(", ")}`);
    }

    // State management pattern
    if (/createContext|useContext/i.test(content)) {
        lines.push("State: React Context");
        tags.push("react-context");
    } else if (/useReducer|dispatch/i.test(content)) {
        lines.push("State: reducer pattern (dispatch/action)");
        tags.push("reducer-pattern");
    } else if (/useState/i.test(content)) {
        lines.push("State: React useState hooks");
        tags.push("react-hooks");
    } else if (/createStore|configureStore/i.test(content)) {
        lines.push("State: Redux store");
        tags.push("redux");
    }

    // Data flow pattern
    if (/fetch\s*\(|axios|XMLHttpRequest/i.test(content)) {
        lines.push("Data: fetches from external API");
        tags.push("api-client");
    }
    if (/export\s+(default\s+)?function|module\.exports/i.test(content)) {
        tags.push("modular");
    }

    // Error handling approach
    const tryCatch = (content.match(/try\s*\{/g) || []).length;
    if (tryCatch >= 2) {
        lines.push(`Error handling: ${tryCatch} try/catch blocks`);
    }

    if (lines.length === 0) return { summary: "", tags: [] };

    return { summary: `### ${fileName}\n${lines.join("\n")}`, tags };
}

function analyzeJSON(fileName: string, content: string): { summary: string; tags: string[] } {
    try {
        const obj = JSON.parse(content);
        const lines: string[] = [];

        // Only record what's useful for understanding the project
        if (obj.name) lines.push(`Project: ${obj.name}`);
        if (obj.dependencies) {
            const deps = Object.keys(obj.dependencies);
            lines.push(`Stack: ${deps.join(", ")}`);
        }
        if (obj.scripts) {
            const scriptNames = Object.keys(obj.scripts);
            lines.push(`Available scripts: ${scriptNames.join(", ")}`);
        }

        if (lines.length === 0) return { summary: "", tags: [] };
        return { summary: `### ${fileName}\n${lines.join("\n")}`, tags: ["config"] };
    } catch {
        return { summary: "", tags: [] };
    }
}

function analyzeMD(fileName: string, _content: string): { summary: string; tags: string[] } {
    // Markdown files are documentation — the content IS the understanding, no need to re-extract
    return { summary: "", tags: ["docs"] };
}
