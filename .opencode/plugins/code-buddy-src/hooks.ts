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
import { askAI, addMemoryWithDedup, extractJSON, extractJSONArray, isLLMAvailable } from "./llm";
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
        // Snapshot the buffer and clear immediately — prevents concurrent
        // subagent flushes from corrupting in-flight data or double-processing.
        const snapshot = [...s.observationBuffer];
        s.clearObservations();
        // Reset per-session guide state so each flush cycle gets fresh matching
        guidesInjected = false;
        guideMatchAttempts = 0;
        s.log(`[code-buddy] 📤 Flushing observations (${reason}, ${snapshot.length} buffered)`);
        try {
            await handleSessionIdle(s, snapshot);
            flushState = "completed";
            s.log(`[code-buddy] ✅ Async flush completed (${reason})`);
        } catch (err) {
            s.log(`[code-buddy] ❌ Async flush failed (${reason}):`, err);
            // Restore snapshot to buffer for sync fallback so data isn't lost
            for (const obs of snapshot) s.pushObservation(obs);
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
                // Only reset flushState when no flush is in progress — prevents
                // a subagent's idle event from interrupting the main agent's flush.
                if (flushState !== "started") flushState = "idle";
                await flushObservations("session.idle");
            }
            // Also flush when session ends (covers `opencode run`)
            if (event.type === "session.deleted") {
                // Allow flush even after a previous cycle completed (subagent may
                // have accumulated new observations after the main agent flushed).
                if (flushState !== "started") flushState = "idle";
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

            // Inject relevant project guides on actual file writes/edits.
            // Only trigger when fileEdited is set (write/edit tools) — NOT bash commands
            // like `ls -la` which have no meaningful content for guide matching.
            // Only trigger on code files — docs (.md, .txt) and config (.json, .yaml) have
            // poor search context and would match wrong guides before the real code file.
            // Retry up to MAX_GUIDE_MATCH_ATTEMPTS times — the first code write may be a
            // config file with poor context, so allow later, more informative writes to match.
            const fileExt = fileEdited?.split(".").pop()?.toLowerCase() || "";
            const isCodeFile = ["html", "js", "ts", "jsx", "tsx", "css", "scss", "py", "go", "rs", "java", "cpp", "c", "rb", "php", "svelte", "vue"].includes(fileExt);
            if (!guidesInjected && fileEdited && isCodeFile && s.memories.length > 0 && guideMatchAttempts < MAX_GUIDE_MATCH_ATTEMPTS) {
                guideMatchAttempts++;

                // Build intent-based search context — match on WHAT the project does,
                // not implementation-level function names.
                const fileContent = String(inputArgs.content || "");
                const searchParts: string[] = [];

                // 1. SPEC.md content — the user's actual requirements (best signal)
                const specContent = extractSpecContent(s.observationBuffer);
                if (specContent) searchParts.push(specContent);

                // 2. Domain keywords — conceptual nouns from identifiers and HTML text
                const domainKw = extractDomainKeywords(fileContent);
                if (domainKw.length > 0) searchParts.push(domainKw.join(" "));

                // 3. HTML <title> — project identity
                const titleMatch = fileContent.match(/<title>(.+?)<\/title>/i);
                if (titleMatch) searchParts.push(titleMatch[1]);

                // 4. Function names — last-resort fallback only when nothing else available
                if (searchParts.length === 0) {
                    if (fileEdited) searchParts.push(fileEdited.split("/").pop() || "");
                    const funcNames = fileContent.match(/function\s+(\w+)/g);
                    if (funcNames) searchParts.push(...funcNames.slice(0, 8).map((f) => f.replace("function ", "")));
                    if (output.title) searchParts.push(output.title);
                }

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

async function handleSessionIdle(s: PluginState, buf: Observation[]): Promise<void> {
    s.session.lastActivity = Date.now();

    // Reminder (only when NOT in fullAuto mode)
    if (s.config.hooks.autoRemind && !s.config.hooks.fullAuto && s.session.tasksCompleted > 0) {
        s.log(`[code-buddy] 💡 Reminder: ${s.session.tasksCompleted} task(s) completed. Use buddy_done to record results.`);
    }

    // Auto-observer — operates on the snapshot passed in, not s.observationBuffer,
    // so concurrent subagent observations don't corrupt the in-flight processing.
    if (!s.config.hooks.autoObserve || buf.length < s.config.hooks.observeMinActions) return;

    // Action-type filter: skip recording for read-only sessions (unless errors detected)
    if (s.config.hooks.requireEditForRecord) {
        const hasWriteAction = buf.some((o) => o.isWriteAction);
        const hasErrors = buf.some((o) => o.hasError);

        if (!hasWriteAction && !hasErrors) {
            s.log("[code-buddy] 📖 Read-only session detected, skipping auto-record");
            return;
        }
    }

    try {
        if (s.config.hooks.fullAuto) {
            await processFullAutoObserver(s, buf);
        } else {
            await processSingleSummaryObserver(s, buf);
        }
    } catch (err) {
        s.log("[code-buddy] Observer error:", err);
    }
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

// ---- LLM refinement for rule-extracted summaries ----

/**
 * Ask the LLM to clean a rule-extracted memory summary.
 * Rules do fast pattern-matching but leak generic code words (handler, key, pressed).
 * The LLM judges which words are true domain entities vs noise.
 *
 * Returns the original summary unchanged if LLM is unavailable or fails.
 */
async function refineWithLLM(s: PluginState, summary: string): Promise<string> {
    if (!(await isLLMAvailable(s))) return summary;
    if (summary.length < 30) return summary;

    const prompt = `Clean this project memory summary. Remove generic code words that aren't specific to the project's domain.

DRAFT:
${summary}

Rules:
- "Key objects" should only list real domain entities the user cares about (paddle, ball, bricks, snake, food, tile, enemy, player, inventory). Remove generic programming words (handler, key, pressed, game, overlap, over, particles, trail, display, screen, collisions, message, etc.)
- "Controls" should say what the player controls and how (e.g. "paddle via mouse, movement via arrow keys"). Don't say "mouse movement" alone — say what is moved.
- Keep all other lines (Project, Architecture, Game loop, Physics, Collision, Game state, Persistence, Font, Audio, UI headings, UI buttons) — just fix obvious noise in them.
- Return the cleaned summary in the exact same "Key: value. Key: value." format.
- If Key objects would be empty after cleaning, drop that line entirely.
- Do NOT add information that wasn't in the draft. Only clean/filter.

Respond with ONLY the cleaned summary text, no explanation.`;

    try {
        const response = await askAI(s, prompt);
        // Validate: must still look like a summary (has "Project:" or similar markers)
        const cleaned = response.trim();
        if (cleaned.length < 20) return summary;
        if (cleaned.startsWith("[AI Analysis")) return summary; // askAI fallback marker
        if (/^(Project|Key objects|Architecture|Controls|Game)/i.test(cleaned)) {
            s.log(`[code-buddy] 🧹 LLM refined summary (${summary.length} → ${cleaned.length} chars)`);
            return cleaned;
        }
        return summary;
    } catch {
        return summary;
    }
}

/**
 * Build meaningful fallback entries from raw observation data.
 * Used when AI classification fails or no LLM is available.
 *
 * Uses analyzeFileContent to extract structural understanding from
 * edited files (game loops, state patterns, layout strategy, etc.)
 * instead of grabbing raw code first-lines.
 */
function buildFallbackEntries(
    buf: Observation[],
    editedFiles: string[],
    hasErrors: boolean,
): AutoEntry[] {
    const entries: AutoEntry[] = [];
    const { intent, type } = classifyIntent(buf, editedFiles, hasErrors);

    const fileNames = editedFiles.map(shortFileName).filter(Boolean);
    const projectName = extractProjectName(buf, editedFiles);

    let title: string;
    let summary: string;

    if (fileNames.length > 0) {
        const verb = intent === "debugging" ? "Fixed"
            : intent === "refactoring" ? "Refactored"
            : "Built";

        // Use project name in title when available (e.g. "Built 2048 game")
        if (projectName) {
            title = `${verb} ${projectName}`;
        } else {
            title = fileNames.length <= 2
                ? `${verb} ${fileNames.join(", ")}`
                : `${verb} ${fileNames.slice(0, 2).join(", ")} +${fileNames.length - 2} more`;
        }

        // Read edited files from disk and extract structural understanding
        // (same analysis as flushBuildSession — detects game loops, state, layout, etc.)
        const analyses: string[] = [];
        const analysisTags: string[] = [];
        for (const filePath of editedFiles) {
            try {
                const content = fs.readFileSync(filePath, "utf-8");
                const analysis = analyzeFileContent(filePath, content);
                if (analysis.summary) {
                    // Strip the "### filename\n" header — we just want the insights
                    const lines = analysis.summary.split("\n").filter((l) => !l.startsWith("### "));
                    analyses.push(...lines.filter(Boolean));
                }
                analysisTags.push(...analysis.tags);
            } catch { /* file may not exist */ }
        }

        if (analyses.length > 0) {
            // Sort analysis lines by importance — ensures truncation preserves the most useful info
            const priorityOrder: [RegExp, number][] = [
                [/^Project:/i, 0],
                [/^UI headings:/i, 1],
                [/^Key objects:/i, 2],
                [/^Controls:/i, 3],
                [/^Game state:/i, 4],
                [/^UI buttons:/i, 5],
                [/^Architecture:/i, 6],
                [/^Game loop:/i, 7],
                [/^Physics:/i, 8],
                [/^Collision:/i, 9],
                [/^Persistence:/i, 10],
                [/^Font:/i, 11],
                [/^Audio:/i, 12],
            ];
            const getPriority = (line: string): number => {
                for (const [pattern, pri] of priorityOrder) {
                    if (pattern.test(line)) return pri;
                }
                return 99;
            };
            analyses.sort((a, b) => getPriority(a) - getPriority(b));

            // Join the structural insights into a readable summary
            summary = analyses.slice(0, 15).join(". ").replace(/\.\./g, ".");
        } else {
            // No file-level insights — try bash command descriptions
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

    const tags = [...new Set([...inferTags(buf, editedFiles)])].slice(0, 5);

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

async function processFullAutoObserver(s: PluginState, buf: Observation[]): Promise<void> {
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
        // Refine rule-based summaries with LLM (no-op if LLM unavailable)
        for (const entry of fallback) {
            entry.summary = await refineWithLLM(s, entry.summary);
        }
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

async function processSingleSummaryObserver(s: PluginState, buf: Observation[]): Promise<void> {

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
            summary: await refineWithLLM(s, entry.summary),
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
    // Snapshot the buffer — saveMemoryWithSyncDedup calls s.clearObservations()
    // internally, which would zero-out a live reference mid-processing.
    const buf = [...s.observationBuffer];
    s.clearObservations();
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

    // Add file context — helps understand what area the bug is in
    for (const filePath of editedFiles.slice(0, 2)) {
        try {
            const fileContent = fs.readFileSync(filePath, "utf-8");
            const analysis = analyzeFileContent(filePath, fileContent);
            if (analysis.summary) sections.push("", "### Context", analysis.summary);
        } catch { /* file may not exist */ }
    }

    sections.push("", "### Prevention");
    sections.push("Watch for this pattern in future sessions.");

    const guide = sections.join("\n").substring(0, 3000);
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
        if (/canvas|getContext\s*\(\s*['"]2d/i.test(newStr) && !/canvas|getContext/i.test(oldStr)) {
            capabilities.push("canvas rendering");
        }
        if (/AudioContext|new\s+Audio/i.test(newStr) && !/AudioContext|new\s+Audio/i.test(oldStr)) {
            capabilities.push("audio playback");
        }
        if (/WebSocket|socket\.io/i.test(newStr) && !/WebSocket|socket\.io/i.test(oldStr)) {
            capabilities.push("real-time communication (WebSocket)");
        }
        if (/IntersectionObserver|MutationObserver/i.test(newStr)) {
            capabilities.push("DOM observation (IntersectionObserver/MutationObserver)");
        }
        if (/drag|draggable|ondrop/i.test(newStr) && !/drag/i.test(oldStr)) {
            capabilities.push("drag-and-drop interaction");
        }
        // New CSS patterns
        if (/@media/i.test(newStr) && !/@media/i.test(oldStr)) {
            capabilities.push("responsive breakpoints");
        }
        if (/--[\w-]+:/i.test(newStr) && !/--[\w-]+:/i.test(oldStr)) {
            capabilities.push("CSS custom properties (theming)");
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
    for (const filePath of editedFiles.slice(0, 3)) {
        try {
            const content = fs.readFileSync(filePath, "utf-8");
            const analysis = analyzeFileContent(filePath, content);
            if (analysis.summary) sections.push("", analysis.summary);
        } catch { /* file may not exist */ }
    }

    const guide = sections.join("\n").substring(0, 3000);
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

    // SPEC.md requirements — primary matching surface for future guide lookups
    const specContent = extractSpecContent(buf);
    if (specContent) {
        sections.push("", "### Requirements", specContent);
    }

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

    // Extract key edit patterns — what development approach was used
    const editObs = buf.filter((o) => o.tool === "edit" || o.tool.toLowerCase().includes("edit"));
    if (editObs.length >= 3) {
        sections.push("", `### Development approach`);
        sections.push(`${editObs.length} edits across ${fileNames.length} file(s)`);
        // Check if iterative (many small edits) vs batch (few large edits)
        const avgEditSize = editObs.reduce((sum, o) => {
            const newStr = (o.args?.new_string || o.args?.newString || "") as string;
            return sum + newStr.length;
        }, 0) / editObs.length;
        if (avgEditSize < 100 && editObs.length >= 5) {
            sections.push("Pattern: iterative refinement (many small targeted edits)");
        } else if (avgEditSize > 500) {
            sections.push("Pattern: batch implementation (large code blocks)");
        }
    }

    const guide = sections.join("\n").substring(0, 3000);
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
    if (ext === "css" || ext === "scss" || ext === "less") return analyzeCSS(fileName, content);
    if (ext === "js" || ext === "ts" || ext === "jsx" || ext === "tsx" || ext === "mjs") return analyzeJS(fileName, content);
    if (ext === "json") return analyzeJSON(fileName, content);
    if (ext === "py") return analyzePython(fileName, content);
    if (ext === "md") return analyzeMD(fileName, content);
    if (ext === "yaml" || ext === "yml" || ext === "toml") return analyzeConfig(fileName, content);
    if (ext === "sql") return analyzeSQL(fileName, content);

    return { summary: "", tags: [] };
}

function analyzeHTML(fileName: string, content: string): { summary: string; tags: string[] } {
    const lines: string[] = [];
    const tags: string[] = [];

    // Project identity
    const title = content.match(/<title>(.+?)<\/title>/i);
    if (title) lines.push(`Project: "${title[1]}"`);

    // Architecture decision — single-file vs multi-file, canvas vs DOM
    const hasInlineCSS = /<style[\s>]/i.test(content);
    const hasInlineJS = /<script[\s>]/i.test(content);
    const externalCSS = content.match(/href="([^"]+\.css)"/gi) || [];
    const externalJS = content.match(/src="([^"]+\.js)"/gi) || [];
    const hasCanvas = /<canvas/i.test(content);
    const renderType = hasCanvas ? "canvas" : "DOM";
    if (hasInlineCSS && hasInlineJS && externalCSS.length === 0 && externalJS.length === 0) {
        lines.push(`Architecture: Single-file ${renderType} app`);
        tags.push("single-file-app");
    } else if (externalCSS.length > 0 || externalJS.length > 0) {
        const externals = [...externalCSS, ...externalJS].map((e) => e.match(/["']([^"']+)["']/)?.[1] || "").filter(Boolean);
        if (externals.length > 0) lines.push(`Architecture: Multi-file ${renderType} app (${externals.join(", ")})`);
    }

    // Domain objects — the key entities of the project (paddle, ball, bricks, score)
    // These are extracted from identifier nouns, not raw function names.
    const domainObjs = extractDomainObjects(content);
    if (domainObjs.length > 0) {
        lines.push(`Key objects: ${domainObjs.slice(0, 12).join(", ")}`);
    }

    // UI headings — visible text that describes what the project shows
    const headings = content.match(/<h[1-6][^>]*>([^<]+)<\/h[1-6]>/gi) || [];
    const headingTexts = headings.map((h) => h.replace(/<[^>]+>/g, "").trim()).filter(Boolean);
    if (headingTexts.length > 0) {
        lines.push(`UI headings: ${headingTexts.slice(0, 5).join(", ")}`);
    }

    // UI buttons — interactive elements
    const buttons = content.match(/<button[^>]*>([^<]+)<\/button>/gi) || [];
    const buttonTexts = buttons.map((b) => b.replace(/<[^>]+>/g, "").trim()).filter(Boolean);
    if (buttonTexts.length > 0) {
        lines.push(`UI buttons: ${[...new Set(buttonTexts)].slice(0, 5).join(", ")}`);
    }

    // Font — simplified to just the name
    const googleFonts = content.match(/fonts\.googleapis\.com\/css2?\?family=([^"&]+)/i);
    if (googleFonts) {
        const fontName = decodeURIComponent(googleFonts[1]).replace(/\+/g, " ").split(":")[0];
        lines.push(`Font: ${fontName}`);
    } else {
        const fontFamilies = content.match(/font-family:\s*([^;}{]+)/gi) || [];
        if (fontFamilies.length > 0) {
            const fonts = [...new Set(fontFamilies.map((f) => f.replace(/font-family:\s*/i, "").trim().split(",")[0].replace(/['"]/g, "")))];
            if (fonts.length > 0 && fonts[0].length > 0) lines.push(`Font: ${fonts[0]}`);
        }
    }

    // Game loop / update pattern
    if (/requestAnimationFrame/i.test(content)) {
        const deltaTime = /delta|dt|elapsed|lastTime|previousTime/i.test(content);
        lines.push(`Game loop: frame-based${deltaTime ? " with delta-time" : ""}`);
        tags.push("game-loop");
    } else {
        const intervals = content.match(/setInterval\s*\([^,]+,\s*(\d+)\)/);
        if (intervals) {
            lines.push(`Game loop: interval-based at ${intervals[1]}ms`);
            tags.push("timer-based");
        }
    }

    // Movement / physics model
    if (/velocity|speed|acceleration|dx|dy/i.test(content)) {
        const gravity = /gravity|gravit/i.test(content);
        const friction = /friction|drag|damping/i.test(content);
        const extras = [gravity ? "gravity" : "", friction ? "friction" : ""].filter(Boolean);
        lines.push(`Physics: velocity-based${extras.length > 0 ? ` with ${extras.join(", ")}` : " movement"}`);
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

    // Input handling — describe input methods
    const keyHandler = content.match(/addEventListener\s*\(\s*['"]key(down|up|press)['"]/gi);
    const mouseHandler = content.match(/addEventListener\s*\(\s*['"](click|mouse\w+|touch\w+)['"]/gi);
    const controls: string[] = [];
    if (/mousemove/i.test(content)) controls.push("mouse movement");
    else if (mouseHandler) controls.push("mouse/click");
    if (/ArrowLeft|ArrowRight|ArrowUp|ArrowDown/i.test(content)) controls.push("arrow keys");
    else if (keyHandler && !controls.some((c) => c.includes("arrow"))) controls.push("keyboard");
    if (/['"](w|a|s|d)['"]/i.test(content) && /key/i.test(content)) controls.push("WASD");
    if (/touchstart|touchmove|touchend/i.test(content)) controls.push("touch");
    if (/swipe|gesture/i.test(content)) controls.push("swipe");
    if (controls.length > 0) lines.push(`Controls: ${controls.join(", ")}`);

    // Scoring / UI state
    const scorePattern = /(?:let|const|var)\s+(?:score|points|level|lives|health)\b/gi;
    const scoreVars = content.match(scorePattern) || [];
    if (scoreVars.length > 0) {
        const varNames = scoreVars.map((s) => s.replace(/(?:let|const|var)\s+/i, "").trim());
        lines.push(`Game state: ${varNames.join(", ")}`);
    }

    // Canvas — just tag it, don't record dimensions (implementation detail)
    if (/<canvas/i.test(content)) {
        tags.push("canvas-rendering");
    }

    // Persistence — what gets saved and how
    if (/localStorage/i.test(content)) {
        const keys = content.match(/localStorage\.\w+Item\s*\(\s*['"]([^'"]+)['"]/g) || [];
        const keyNames = [...new Set(keys.map((k) => k.match(/['"]([^'"]+)['"]/)?.[1] || ""))].filter(Boolean);
        lines.push(`Persistence: localStorage${keyNames.length > 0 ? ` (keys: ${keyNames.join(", ")})` : ""}`);
    }

    // Rendering approach — simplified (canvas vs DOM)
    if (/<canvas/i.test(content) && /\.getContext|ctx\./i.test(content)) {
        // Already captured as "canvas-rendering" tag and architecture line
    } else if (/innerHTML|appendChild|createElement|\.textContent/i.test(content)) {
        tags.push("dom-rendering");
    }

    // Audio — simplified
    if (/new\s+Audio|\.play\s*\(|AudioContext|createOscillator/i.test(content)) {
        const webAudio = /AudioContext|createOscillator/i.test(content);
        lines.push(`Audio: ${webAudio ? "Web Audio API" : "HTML5 Audio"}`);
        tags.push("audio");
    }

    if (lines.length === 0) return { summary: "", tags: [] };

    return {
        summary: `### ${fileName}\n${lines.join("\n")}`,
        tags: tags.slice(0, 7),
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
        const gap = content.match(/(?:grid-)?gap:\s*([^;]+)/i);
        if (gap) lines.push(`Grid gap: ${gap[1].trim()}`);
        tags.push("css-grid");
    } else if (hasFlex) {
        const flexDir = content.match(/flex-direction:\s*(\w+)/i);
        lines.push(`Layout: Flexbox${flexDir ? ` (${flexDir[1]})` : ""}`);
        tags.push("flexbox");
    }

    // Color palette — extract meaningful color definitions
    const colorProps = content.match(/(?:color|background(?:-color)?|border(?:-color)?|fill|stroke):\s*([^;}{]+)/gi) || [];
    const uniqueColors = new Set<string>();
    for (const prop of colorProps) {
        const val = prop.split(":")[1]?.trim();
        if (val && !/inherit|initial|currentColor|transparent|none/i.test(val)) {
            uniqueColors.add(val.substring(0, 40));
        }
    }
    if (uniqueColors.size >= 3) {
        const palette = [...uniqueColors].slice(0, 6).join(", ");
        lines.push(`Color palette: ${palette}`);
    }

    // Gradients
    const gradients = content.match(/(?:linear|radial|conic)-gradient\([^)]+\)/gi) || [];
    if (gradients.length > 0) {
        lines.push(`Gradients: ${gradients[0].substring(0, 80)}`);
    }

    // Theming approach — CSS variables indicate a theming system
    const vars = content.match(/--[\w-]+:\s*[^;]+/g) || [];
    if (vars.length >= 3) {
        const varEntries = vars.slice(0, 6).map((v) => v.trim());
        lines.push(`CSS custom properties: ${varEntries.join("; ")}`);
        tags.push("css-variables");
    }

    // Typography — fonts, sizes, weights
    const fontFamilies = content.match(/font-family:\s*([^;}{]+)/gi) || [];
    if (fontFamilies.length > 0) {
        const fonts = [...new Set(fontFamilies.map((f) => f.replace(/font-family:\s*/i, "").trim()))];
        lines.push(`Typography: ${fonts.slice(0, 3).join(", ")}`);
    }
    const fontSizes = content.match(/font-size:\s*([^;}{]+)/gi) || [];
    if (fontSizes.length >= 3) {
        const sizes = [...new Set(fontSizes.map((f) => f.replace(/font-size:\s*/i, "").trim()))];
        lines.push(`Font scale: ${sizes.slice(0, 5).join(", ")}`);
    }

    // Spacing system — detect rem/em/px consistency
    const spacings = content.match(/(?:margin|padding|gap)(?:-\w+)?:\s*([^;}{]+)/gi) || [];
    if (spacings.length >= 3) {
        const units = spacings.map((s) => s.split(":")[1]?.trim() || "");
        const usesRem = units.some((u) => /rem/i.test(u));
        const usesPx = units.some((u) => /px/i.test(u));
        const usesEm = units.some((u) => /\dem\b/i.test(u));
        const system = usesRem ? "rem-based" : usesEm ? "em-based" : usesPx ? "px-based" : "mixed";
        lines.push(`Spacing: ${system} units`);
    }

    // Naming methodology — detect BEM, utility classes, etc.
    const selectors = content.match(/[.#][\w-]+/g) || [];
    if (selectors.length >= 5) {
        const bemPattern = selectors.filter((s) => /__.+--|--\w/.test(s));
        const utilPattern = selectors.filter((s) => /^\.(?:flex|grid|text-|bg-|p-|m-|w-|h-|rounded|shadow)/i.test(s));
        if (bemPattern.length >= 3) {
            lines.push("Naming: BEM methodology (block__element--modifier)");
            tags.push("bem");
        } else if (utilPattern.length >= 3) {
            lines.push("Naming: Utility-first classes");
            tags.push("utility-css");
        }
    }

    // Animation approach — what animates and how
    const keyframes = content.match(/@keyframes\s+(\w[\w-]*)/g) || [];
    if (keyframes.length > 0) {
        const names = keyframes.map((k) => k.replace("@keyframes ", ""));
        lines.push(`Animations: ${names.join(", ")} (CSS keyframes)`);
        tags.push("css-animations");
    }
    const transitions = content.match(/transition:\s*([^;]+)/gi) || [];
    if (transitions.length > 0) {
        const props = [...new Set(transitions.map((t) => t.replace(/transition:\s*/i, "").trim().substring(0, 40)))];
        if (keyframes.length === 0) {
            lines.push(`Transitions: ${props.slice(0, 3).join(", ")}`);
        }
    }

    // Transforms
    const transforms = content.match(/transform:\s*([^;]+)/gi) || [];
    if (transforms.length >= 2) {
        const types = [...new Set(transforms.map((t) => {
            const val = t.replace(/transform:\s*/i, "").trim();
            return val.match(/\w+(?=\()/)?.[0] || val.substring(0, 20);
        }))];
        lines.push(`Transforms: ${types.slice(0, 4).join(", ")}`);
    }

    // Box shadows / visual depth
    const shadows = content.match(/box-shadow:\s*([^;]+)/gi) || [];
    if (shadows.length >= 2) {
        lines.push(`Shadows: ${shadows.length} box-shadow rules (depth/elevation system)`);
    }

    // Responsive design — extract actual breakpoints
    const mediaQueries = content.match(/@media[^{]+/g) || [];
    if (mediaQueries.length > 0) {
        const breakpoints = mediaQueries
            .map((m) => m.match(/(\d+)\s*px/)?.[1])
            .filter(Boolean);
        if (breakpoints.length > 0) {
            lines.push(`Responsive: breakpoints at ${[...new Set(breakpoints)].join(", ")}px`);
        } else {
            lines.push(`Responsive: ${mediaQueries.length} media query/queries`);
        }
    }

    // Pseudo-elements (decorative patterns)
    const pseudos = content.match(/::(?:before|after)/g) || [];
    if (pseudos.length >= 2) {
        lines.push(`Decorative: ${pseudos.length} pseudo-element(s) for visual effects`);
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
        // Check for inheritance
        const extensions = content.match(/class\s+\w+\s+extends\s+(\w+)/g) || [];
        if (extensions.length > 0) {
            const parents = extensions.map((e) => e.match(/extends\s+(\w+)/)?.[1] || "");
            lines.push(`Architecture: class-based (${names.join(", ")}) extends ${parents.join(", ")}`);
        } else {
            lines.push(`Architecture: class-based (${names.join(", ")})`);
        }
        tags.push("class-based");
    } else {
        // Check for functional patterns
        const arrowFns = (content.match(/(?:const|let)\s+\w+\s*=\s*(?:\([^)]*\)|[\w]+)\s*=>/g) || []).length;
        const regularFns = (content.match(/function\s+\w+/g) || []).length;
        if (arrowFns > regularFns && arrowFns >= 3) {
            lines.push("Architecture: functional (arrow functions)");
            tags.push("functional");
        } else if (regularFns >= 3) {
            lines.push("Architecture: procedural (named functions)");
        }
    }

    // Module structure
    if (imports.length > 0) {
        const externals = imports
            .map((i) => i.match(/from\s+['"]([^'"]+)['"]/)?.[1] || "")
            .filter((m) => m && !m.startsWith("."));
        const internals = imports
            .map((i) => i.match(/from\s+['"]([^'"]+)['"]/)?.[1] || "")
            .filter((m) => m && m.startsWith("."));
        if (externals.length > 0) lines.push(`Dependencies: ${externals.join(", ")}`);
        if (internals.length >= 2) lines.push(`Internal modules: ${internals.length} local imports`);
    }
    const exports = content.match(/export\s+(?:default\s+)?(?:function|class|const|let|{)/g) || [];
    if (exports.length > 0) {
        tags.push("modular");
    }

    // React component patterns
    const jsxReturn = /return\s*\(\s*</i.test(content) || /return\s+</i.test(content);
    if (jsxReturn) {
        tags.push("react-component");
        const useEffect = (content.match(/useEffect/g) || []).length;
        const useMemo = (content.match(/useMemo/g) || []).length;
        const useCallback = (content.match(/useCallback/g) || []).length;
        const useRef = (content.match(/useRef/g) || []).length;
        const hooks = [];
        if (useEffect > 0) hooks.push(`useEffect(${useEffect})`);
        if (useMemo > 0) hooks.push(`useMemo(${useMemo})`);
        if (useCallback > 0) hooks.push(`useCallback(${useCallback})`);
        if (useRef > 0) hooks.push(`useRef(${useRef})`);
        if (hooks.length > 0) lines.push(`React hooks: ${hooks.join(", ")}`);
    }

    // Custom hooks
    const customHooks = content.match(/(?:export\s+)?function\s+use[A-Z]\w+/g) || [];
    if (customHooks.length > 0) {
        const names = customHooks.map((h) => h.match(/use[A-Z]\w+/)?.[0] || "");
        lines.push(`Custom hooks: ${names.join(", ")}`);
        tags.push("custom-hooks");
    }

    // State management pattern
    if (/createContext|useContext/i.test(content)) {
        const contextNames = content.match(/create(?:Context|context)\s*[<(]/g) || [];
        lines.push(`State: React Context${contextNames.length > 1 ? ` (${contextNames.length} contexts)` : ""}`);
        tags.push("react-context");
    } else if (/useReducer|dispatch/i.test(content)) {
        // Try to extract action types
        const actionTypes = content.match(/['"](\w+)['"]\s*:/g) || [];
        const typeNames = actionTypes.slice(0, 4).map((a) => a.replace(/['":\s]/g, ""));
        lines.push(`State: reducer pattern${typeNames.length > 0 ? ` (actions: ${typeNames.join(", ")})` : ""}`);
        tags.push("reducer-pattern");
    } else if (/useState/i.test(content)) {
        const stateVars = content.match(/const\s+\[(\w+),\s*set\w+\]\s*=\s*useState/g) || [];
        const names = stateVars.map((s) => s.match(/\[(\w+)/)?.[1] || "").filter(Boolean);
        lines.push(`State: React useState${names.length > 0 ? ` (${names.join(", ")})` : ""}`);
        tags.push("react-hooks");
    } else if (/createStore|configureStore/i.test(content)) {
        lines.push("State: Redux store");
        tags.push("redux");
    } else if (/createSignal|createStore|createEffect/i.test(content)) {
        lines.push("State: SolidJS signals");
        tags.push("solid-js");
    } else if (/writable|readable|derived/i.test(content) && /\$:/i.test(content)) {
        lines.push("State: Svelte stores");
        tags.push("svelte");
    }

    // Async patterns
    const asyncFns = (content.match(/async\s+(?:function|\w+\s*=)/g) || []).length;
    const awaits = (content.match(/await\s+/g) || []).length;
    const promises = (content.match(/new\s+Promise|\.then\s*\(/g) || []).length;
    if (asyncFns >= 2 || awaits >= 3) {
        lines.push(`Async: ${asyncFns} async function(s), ${awaits} await(s)`);
        tags.push("async-await");
    } else if (promises >= 2) {
        lines.push(`Async: Promise chain pattern (${promises} .then calls)`);
        tags.push("promise-chains");
    }

    // Data flow pattern
    if (/fetch\s*\(|axios|XMLHttpRequest/i.test(content)) {
        const endpoints = content.match(/(?:fetch|get|post|put|delete|patch)\s*\(\s*[`'"](\/[^`'"]+|https?:\/\/[^`'"]+)/gi) || [];
        if (endpoints.length > 0) {
            const paths = endpoints.slice(0, 3).map((e) => e.match(/[`'"](\/[^`'"]+|https?:\/\/[^`'"]+)/)?.[1] || "").filter(Boolean);
            lines.push(`API: ${paths.join(", ")}`);
        } else {
            lines.push("Data: fetches from external API");
        }
        tags.push("api-client");
    }

    // Event patterns
    const eventEmitters = /\.emit\s*\(|\.on\s*\(.*,\s*(?:function|\()/i.test(content);
    const customEvents = /new\s+CustomEvent|dispatchEvent/i.test(content);
    if (eventEmitters) {
        lines.push("Events: event emitter pattern (pub/sub)");
        tags.push("event-driven");
    } else if (customEvents) {
        lines.push("Events: CustomEvent dispatch pattern");
        tags.push("event-driven");
    }

    // TypeScript specifics
    const interfaces = content.match(/interface\s+(\w+)/g) || [];
    const typeAliases = content.match(/type\s+(\w+)\s*=/g) || [];
    const generics = (content.match(/<\w+(?:\s*extends\s*\w+)?>/g) || []).length;
    if (interfaces.length > 0 || typeAliases.length > 0) {
        const names = [
            ...interfaces.map((i) => i.replace("interface ", "")),
            ...typeAliases.map((t) => t.replace(/type\s+/, "").replace(/\s*=/, "")),
        ];
        lines.push(`Types: ${names.slice(0, 5).join(", ")}${generics >= 2 ? ` (${generics} generic types)` : ""}`);
        tags.push("typescript");
    }

    // Enums / constants pattern
    const enums = content.match(/enum\s+(\w+)/g) || [];
    const constObjects = content.match(/const\s+(\w+)\s*=\s*\{[^}]+\}\s*as\s+const/g) || [];
    if (enums.length > 0) {
        const names = enums.map((e) => e.replace("enum ", ""));
        lines.push(`Enums: ${names.join(", ")}`);
    } else if (constObjects.length > 0) {
        lines.push(`Constants: ${constObjects.length} const assertion object(s)`);
    }

    // Key data structures
    const maps = (content.match(/new\s+Map/g) || []).length;
    const sets = (content.match(/new\s+Set/g) || []).length;
    const weakMaps = (content.match(/new\s+WeakMap/g) || []).length;
    if (maps + sets + weakMaps >= 2) {
        const structs = [];
        if (maps > 0) structs.push(`Map(${maps})`);
        if (sets > 0) structs.push(`Set(${sets})`);
        if (weakMaps > 0) structs.push(`WeakMap(${weakMaps})`);
        lines.push(`Data structures: ${structs.join(", ")}`);
    }

    // Error handling approach
    const tryCatch = (content.match(/try\s*\{/g) || []).length;
    if (tryCatch >= 2) {
        const customErrors = content.match(/class\s+\w+\s+extends\s+Error/g) || [];
        if (customErrors.length > 0) {
            lines.push(`Error handling: ${tryCatch} try/catch + custom error class(es)`);
        } else {
            lines.push(`Error handling: ${tryCatch} try/catch blocks`);
        }
    }

    // Testing patterns
    if (/describe\s*\(|it\s*\(|test\s*\(|expect\s*\(/i.test(content)) {
        const describes = (content.match(/describe\s*\(/g) || []).length;
        const tests = (content.match(/(?:it|test)\s*\(/g) || []).length;
        lines.push(`Tests: ${tests} test case(s)${describes > 0 ? ` in ${describes} suite(s)` : ""}`);
        tags.push("testing");
    }

    // Domain objects — key entities extracted from identifier nouns
    const jsDomainObjs = extractDomainObjects(content);
    if (jsDomainObjs.length > 0) {
        lines.push(`Key objects: ${jsDomainObjs.slice(0, 12).join(", ")}`);
    }

    // Naming conventions — detect camelCase vs snake_case vs kebab-case
    const fnNames = content.match(/(?:function|const|let)\s+([a-z]\w+)/g) || [];
    if (fnNames.length >= 5) {
        const names = fnNames.map((n) => n.match(/\s+(\w+)$/)?.[1] || "");
        const camel = names.filter((n) => /[a-z][A-Z]/.test(n)).length;
        const snake = names.filter((n) => /_/.test(n) && !/[A-Z]/.test(n)).length;
        if (camel > snake && camel >= 3) lines.push("Naming: camelCase convention");
        else if (snake > camel && snake >= 3) lines.push("Naming: snake_case convention");
    }

    if (lines.length === 0) return { summary: "", tags: [] };

    return { summary: `### ${fileName}\n${lines.join("\n")}`, tags: tags.slice(0, 7) };
}

function analyzeJSON(fileName: string, content: string): { summary: string; tags: string[] } {
    try {
        const obj = JSON.parse(content);
        const lines: string[] = [];
        const tags: string[] = ["config"];

        if (fileName === "package.json" || obj.dependencies || obj.devDependencies) {
            // package.json — extract full development context
            if (obj.name) lines.push(`Project: ${obj.name}${obj.version ? ` v${obj.version}` : ""}`);
            if (obj.description) lines.push(`Purpose: ${obj.description.substring(0, 100)}`);
            if (obj.dependencies) {
                const deps = Object.keys(obj.dependencies);
                // Categorize: UI frameworks, state, utils, etc.
                const frameworks = deps.filter((d) => /react|vue|svelte|angular|next|nuxt|solid|preact/i.test(d));
                const others = deps.filter((d) => !frameworks.includes(d));
                if (frameworks.length > 0) {
                    lines.push(`Framework: ${frameworks.join(", ")}`);
                    tags.push(...frameworks.map((f) => f.replace(/@.*/, "")));
                }
                if (others.length > 0) lines.push(`Dependencies: ${others.join(", ")}`);
            }
            if (obj.devDependencies) {
                const devDeps = Object.keys(obj.devDependencies);
                const testTools = devDeps.filter((d) => /jest|vitest|mocha|cypress|playwright|testing/i.test(d));
                const buildTools = devDeps.filter((d) => /webpack|vite|esbuild|rollup|parcel|turbopack/i.test(d));
                const linters = devDeps.filter((d) => /eslint|prettier|biome|stylelint/i.test(d));
                const typeTools = devDeps.filter((d) => /typescript|@types/i.test(d));
                if (testTools.length > 0) {
                    lines.push(`Testing: ${testTools.join(", ")}`);
                    tags.push("testing");
                }
                if (buildTools.length > 0) {
                    lines.push(`Build: ${buildTools.join(", ")}`);
                    tags.push("bundler");
                }
                if (linters.length > 0) lines.push(`Linting: ${linters.join(", ")}`);
                if (typeTools.length > 0) {
                    lines.push(`TypeScript: ${typeTools.filter((d) => d !== "typescript").join(", ") || "enabled"}`);
                    tags.push("typescript");
                }
            }
            if (obj.scripts) {
                const scripts = Object.entries(obj.scripts as Record<string, string>);
                const scriptDetails = scripts.slice(0, 6).map(([k, v]) => `${k}: ${String(v).substring(0, 50)}`);
                lines.push(`Scripts: ${scriptDetails.join(", ")}`);
            }
            if (obj.type === "module") lines.push("Module system: ESM (type: module)");
            if (obj.engines) {
                const engines = Object.entries(obj.engines).map(([k, v]) => `${k} ${v}`);
                lines.push(`Engines: ${engines.join(", ")}`);
            }
        } else if (fileName === "tsconfig.json" || obj.compilerOptions) {
            // TypeScript config
            lines.push("TypeScript configuration");
            const co = obj.compilerOptions || {};
            if (co.target) lines.push(`Target: ${co.target}`);
            if (co.module) lines.push(`Module: ${co.module}`);
            if (co.jsx) lines.push(`JSX: ${co.jsx}`);
            if (co.strict !== undefined) lines.push(`Strict mode: ${co.strict}`);
            if (co.paths) {
                const aliases = Object.keys(co.paths);
                lines.push(`Path aliases: ${aliases.join(", ")}`);
            }
            tags.push("typescript");
        } else {
            // Generic JSON — record structure
            if (obj.name) lines.push(`Project: ${obj.name}`);
            const topKeys = Object.keys(obj).slice(0, 8);
            if (topKeys.length > 0) lines.push(`Structure: ${topKeys.join(", ")}`);
        }

        if (lines.length === 0) return { summary: "", tags: [] };
        return { summary: `### ${fileName}\n${lines.join("\n")}`, tags: tags.slice(0, 7) };
    } catch {
        return { summary: "", tags: [] };
    }
}

function analyzePython(fileName: string, content: string): { summary: string; tags: string[] } {
    const lines: string[] = [];
    const tags: string[] = [];

    // Classes and inheritance
    const classes = content.match(/class\s+(\w+)(?:\(([^)]+)\))?:/g) || [];
    if (classes.length > 0) {
        const classInfo = classes.map((c) => {
            const match = c.match(/class\s+(\w+)(?:\(([^)]+)\))?/);
            if (match && match[2]) return `${match[1]}(${match[2]})`;
            return match?.[1] || "";
        });
        lines.push(`Classes: ${classInfo.join(", ")}`);
        tags.push("class-based");
    }

    // Imports — what frameworks/libraries are used
    const importLines = content.match(/(?:from\s+(\S+)\s+import|import\s+(\S+))/g) || [];
    if (importLines.length > 0) {
        const modules = [...new Set(importLines.map((i) => {
            const fromMatch = i.match(/from\s+(\S+)/);
            const importMatch = i.match(/import\s+(\S+)/);
            return (fromMatch?.[1] || importMatch?.[1] || "").replace(/['"]/g, "");
        }))].filter(Boolean);
        const externals = modules.filter((m) => !m.startsWith("."));
        if (externals.length > 0) lines.push(`Dependencies: ${externals.join(", ")}`);
    }

    // Framework detection
    if (/from\s+flask|import\s+flask/i.test(content)) { tags.push("flask"); lines.push("Framework: Flask"); }
    else if (/from\s+django|import\s+django/i.test(content)) { tags.push("django"); lines.push("Framework: Django"); }
    else if (/from\s+fastapi|import\s+fastapi/i.test(content)) { tags.push("fastapi"); lines.push("Framework: FastAPI"); }
    else if (/from\s+starlette/i.test(content)) { tags.push("starlette"); }

    // Decorators — indicate patterns (routes, properties, etc.)
    const decorators = content.match(/@\w[\w.]*(?:\([^)]*\))?/g) || [];
    if (decorators.length > 0) {
        const uniqueDecos = [...new Set(decorators.slice(0, 5).map((d) => d.substring(0, 40)))];
        lines.push(`Decorators: ${uniqueDecos.join(", ")}`);
    }

    // Route definitions (web frameworks)
    const routes = content.match(/@(?:app|router)\.(?:get|post|put|delete|patch|route)\s*\(\s*['"]([^'"]+)['"]/g) || [];
    if (routes.length > 0) {
        const paths = routes.map((r) => r.match(/['"]([^'"]+)['"]/)?.[1] || "");
        lines.push(`Endpoints: ${paths.join(", ")}`);
        tags.push("api-routes");
    }

    // Async patterns
    const asyncDefs = (content.match(/async\s+def\s+\w+/g) || []).length;
    const awaitCalls = (content.match(/await\s+/g) || []).length;
    if (asyncDefs >= 2) {
        lines.push(`Async: ${asyncDefs} async def(s), ${awaitCalls} await(s)`);
        tags.push("async-python");
    }

    // Type hints
    const typeHints = (content.match(/:\s*(?:str|int|float|bool|list|dict|Optional|Union|Tuple|List|Dict|Any)/g) || []).length;
    const returnTypes = (content.match(/->\s*\w+/g) || []).length;
    if (typeHints >= 3 || returnTypes >= 2) {
        lines.push(`Type hints: ${typeHints} parameter type(s), ${returnTypes} return type(s)`);
        tags.push("typed-python");
    }

    // Data models (Pydantic, dataclass, etc.)
    if (/class\s+\w+\(BaseModel\)/i.test(content)) {
        lines.push("Data modeling: Pydantic BaseModel");
        tags.push("pydantic");
    } else if (/@dataclass/i.test(content)) {
        lines.push("Data modeling: dataclasses");
        tags.push("dataclass");
    }

    // Database patterns
    if (/SQLAlchemy|session\.query|db\.session/i.test(content)) {
        lines.push("Database: SQLAlchemy ORM");
        tags.push("sqlalchemy");
    } else if (/cursor\.|\.execute\s*\(/i.test(content)) {
        lines.push("Database: raw SQL queries");
        tags.push("database");
    }

    // Testing patterns
    if (/def\s+test_\w+|class\s+Test\w+|pytest|unittest/i.test(content)) {
        const testFns = (content.match(/def\s+test_\w+/g) || []).length;
        lines.push(`Tests: ${testFns} test function(s)`);
        tags.push("testing");
    }

    // Error handling
    const excepts = (content.match(/except\s+/g) || []).length;
    if (excepts >= 2) {
        lines.push(`Error handling: ${excepts} except clause(s)`);
    }

    // Naming convention — Python uses snake_case by convention, note if violated
    const fnNames = content.match(/def\s+([a-z]\w+)/g) || [];
    if (fnNames.length >= 5) {
        const names = fnNames.map((n) => n.replace("def ", ""));
        const camel = names.filter((n) => /[a-z][A-Z]/.test(n)).length;
        if (camel >= 3) lines.push("Naming: camelCase (non-standard for Python)");
    }

    if (lines.length === 0) return { summary: "", tags: [] };
    return { summary: `### ${fileName}\n${lines.join("\n")}`, tags: tags.slice(0, 7) };
}

function analyzeConfig(fileName: string, content: string): { summary: string; tags: string[] } {
    const lines: string[] = [];
    const tags: string[] = ["config"];

    // YAML/TOML — detect common config types
    if (/docker-compose/i.test(fileName)) {
        const services = content.match(/^\s{2}(\w[\w-]*):/gm) || [];
        if (services.length > 0) {
            const names = services.map((s) => s.trim().replace(":", ""));
            lines.push(`Docker Compose: ${names.join(", ")}`);
            tags.push("docker");
        }
    } else if (/github\/workflows|\.github/i.test(fileName) || /^on:/m.test(content)) {
        const triggers = content.match(/on:\s*\[?([^\]}\n]+)/);
        if (triggers) lines.push(`CI/CD trigger: ${triggers[1].trim()}`);
        tags.push("ci-cd");
    } else if (/pyproject/i.test(fileName)) {
        const name = content.match(/name\s*=\s*["']([^"']+)/);
        if (name) lines.push(`Python project: ${name[1]}`);
        tags.push("python");
    }

    // Extract top-level keys for structure understanding
    const topKeys = content.match(/^[a-zA-Z][\w-]*:/gm) || [];
    if (topKeys.length > 0) {
        const keys = topKeys.slice(0, 8).map((k) => k.replace(":", ""));
        lines.push(`Structure: ${keys.join(", ")}`);
    }

    if (lines.length === 0) return { summary: "", tags: [] };
    return { summary: `### ${fileName}\n${lines.join("\n")}`, tags };
}

function analyzeSQL(fileName: string, content: string): { summary: string; tags: string[] } {
    const lines: string[] = [];
    const tags: string[] = ["database"];

    // Tables
    const creates = content.match(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"']?(\w+)/gi) || [];
    if (creates.length > 0) {
        const tables = creates.map((c) => c.match(/TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"']?(\w+)/i)?.[1] || "");
        lines.push(`Tables: ${tables.join(", ")}`);
    }

    // Indexes
    const indexes = (content.match(/CREATE\s+(?:UNIQUE\s+)?INDEX/gi) || []).length;
    if (indexes > 0) lines.push(`Indexes: ${indexes} index definition(s)`);

    // Foreign keys / relationships
    const fks = (content.match(/FOREIGN\s+KEY|REFERENCES/gi) || []).length;
    if (fks > 0) lines.push(`Relations: ${fks} foreign key constraint(s)`);

    // Migrations pattern
    if (/ALTER\s+TABLE/i.test(content)) {
        lines.push("Contains schema migrations (ALTER TABLE)");
        tags.push("migrations");
    }

    if (lines.length === 0) return { summary: "", tags: [] };
    return { summary: `### ${fileName}\n${lines.join("\n")}`, tags };
}

function analyzeMD(fileName: string, _content: string): { summary: string; tags: string[] } {
    // Markdown files are documentation — the content IS the understanding, no need to re-extract
    return { summary: "", tags: ["docs"] };
}

// ---- Domain extraction helpers for intent-based matching ----

/** Common verb prefixes in code identifiers that should be stripped to get domain nouns. */
const VERB_PREFIXES = [
    "draw", "render", "update", "init", "check", "handle", "on", "get", "set",
    "create", "build", "make", "add", "remove", "delete", "reset", "start",
    "stop", "is", "has", "can", "should", "compute", "calculate", "process",
    "load", "save", "fetch", "parse", "validate", "show", "hide", "toggle",
    "enable", "disable", "register", "emit", "dispatch", "trigger", "apply",
    "setup", "teardown", "destroy", "clear", "find", "search", "filter",
    "sort", "map", "reduce", "transform", "convert", "format", "normalize",
];

/**
 * Generic code nouns that appear in almost any JS/HTML project.
 * These are NOT domain-specific and should be filtered from "Key objects".
 */
const CODE_NOISE_NOUNS = new Set([
    // Programming constructs
    "game", "app", "data", "info", "item", "items", "list", "array", "object",
    "value", "values", "result", "results", "error", "errors", "type", "types",
    "name", "names", "text", "string", "number", "index", "count", "total",
    "flag", "state", "status", "config", "options", "params", "args", "props",
    // DOM / UI generic
    "element", "elements", "container", "wrapper", "content", "section",
    "header", "footer", "body", "main", "div", "span", "btn", "button",
    "input", "output", "label", "form", "link", "image", "icon",
    "display", "screen", "overlay", "modal", "popup", "tooltip", "menu",
    "message", "messages", "notification",
    // Event / control generic
    "handler", "handlers", "listener", "callback", "event", "events",
    "key", "keys", "pressed", "click", "mouse", "touch",
    // Visual / rendering generic
    "color", "colors", "style", "styles", "class", "classes",
    "width", "height", "size", "pos", "position", "rect",
    "ctx", "context", "canvas", "pixel", "pixels",
    "glow", "effect", "effects", "particle", "particles", "trail", "trails",
    "background", "foreground", "border", "shadow", "opacity", "alpha",
    "gradient", "animation", "transition",
    // Math / geometry generic
    "angle", "radius", "speed", "velocity", "delta", "time", "elapsed",
    "min", "max", "step", "offset", "gap", "margin", "padding",
    // Data flow generic
    "temp", "tmp", "current", "prev", "next", "old", "new",
    "start", "end", "left", "right", "top", "bottom", "center",
    // Common code fragments from camelCase splitting
    "over", "down", "up", "off", "out", "back", "info", "all", "none",
    "true", "false", "null", "undefined", "default",
    // Collision-related (generic pattern, not domain-specific)
    "overlap", "collisions", "collision",
]);

/**
 * Split camelCase/PascalCase identifiers into separate words.
 * e.g. "drawPaddle" → ["draw", "Paddle"], "checkCollision" → ["check", "Collision"]
 */
function splitCamelCase(name: string): string[] {
    return name
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
        .split(/\s+/)
        .map((w) => w.toLowerCase())
        .filter((w) => w.length > 1);
}

/**
 * Strip verb prefixes from an identifier to get the domain noun.
 * e.g. "drawPaddle" → "paddle", "checkCollision" → "collision", "updateBall" → "ball"
 * Returns empty string if the identifier IS just a verb with no noun.
 */
function stripVerbPrefix(name: string): string {
    const parts = splitCamelCase(name);
    if (parts.length <= 1) return "";
    const first = parts[0];
    if (VERB_PREFIXES.includes(first)) {
        return parts.slice(1).join("");
    }
    return "";
}

/**
 * Extract domain objects from code content — strip verb prefixes from function/variable
 * names, return nouns appearing 2+ times. These represent the key entities of the project
 * (paddle, ball, bricks, score, etc.) rather than implementation details.
 */
function extractDomainObjects(content: string): string[] {
    // Extract all function and variable names
    const funcNames = content.match(/function\s+(\w+)/g) || [];
    const arrowFuncs = content.match(/(?:const|let|var)\s+(\w+)\s*=\s*(?:\([^)]*\)|[\w]+)\s*=>/g) || [];
    const varDecls = content.match(/(?:let|const|var)\s+(\w+)\s*=/g) || [];

    const allNames = [
        ...funcNames.map((f) => f.replace("function ", "")),
        ...arrowFuncs.map((f) => f.match(/(?:const|let|var)\s+(\w+)/)?.[1] || "").filter(Boolean),
        ...varDecls.map((v) => v.match(/(?:let|const|var)\s+(\w+)/)?.[1] || "").filter(Boolean),
    ];

    /** Check if a word is a domain noun (not a verb prefix or generic code noun). */
    const isDomainNoun = (w: string): boolean =>
        w.length > 2 && !VERB_PREFIXES.includes(w) && !CODE_NOISE_NOUNS.has(w);

    // Count domain nouns (verb-stripped)
    const nounCounts = new Map<string, number>();
    for (const name of allNames) {
        const noun = stripVerbPrefix(name);
        if (noun && isDomainNoun(noun)) {
            nounCounts.set(noun, (nounCounts.get(noun) || 0) + 1);
        }
        // Also count the full name's camelCase parts as nouns
        const parts = splitCamelCase(name);
        for (const part of parts) {
            if (isDomainNoun(part)) {
                nounCounts.set(part, (nounCounts.get(part) || 0) + 1);
            }
        }
    }

    // Also extract nouns from id/class attribute names in HTML
    const idClassNames = content.match(/(?:id|class)=["']([^"']+)["']/gi) || [];
    for (const attr of idClassNames) {
        const val = attr.match(/=["']([^"']+)["']/)?.[1] || "";
        const words = val.split(/[\s-_]+/).filter((w) => w.length > 2);
        for (const w of words) {
            const lower = w.toLowerCase();
            if (isDomainNoun(lower)) {
                nounCounts.set(lower, (nounCounts.get(lower) || 0) + 1);
            }
        }
    }

    // Deduplicate singular/plural — keep the more frequent form
    const deduped = new Map<string, number>();
    for (const [noun, count] of nounCounts) {
        const singular = noun.endsWith("s") ? noun.slice(0, -1) : noun;
        const plural = noun.endsWith("s") ? noun : noun + "s";
        const otherForm = nounCounts.get(noun.endsWith("s") ? singular : plural);
        if (otherForm !== undefined) {
            // Keep whichever form has higher count; on tie keep singular
            const combinedCount = count + otherForm;
            if (!deduped.has(singular) && !deduped.has(plural)) {
                deduped.set(count >= otherForm ? noun : (noun.endsWith("s") ? singular : plural), combinedCount);
            }
        } else {
            if (!deduped.has(singular) && !deduped.has(plural)) {
                deduped.set(noun, count);
            }
        }
    }

    // Return nouns appearing 2+ times, sorted by frequency
    return [...deduped.entries()]
        .filter(([, count]) => count >= 2)
        .sort((a, b) => b[1] - a[1])
        .map(([noun]) => noun)
        .slice(0, 10);
}

/**
 * Extract domain keywords from HTML/code content — conceptual nouns from identifiers
 * (by splitting camelCase and stripping verb prefixes), HTML visible text (<h1>, <h2>,
 * <button> labels), and id/class names.
 */
function extractDomainKeywords(content: string): string[] {
    const keywords = new Set<string>();

    // 1. Domain objects from identifiers
    for (const obj of extractDomainObjects(content)) {
        keywords.add(obj);
    }

    // 2. HTML visible text from headings
    const headings = content.match(/<h[1-6][^>]*>([^<]+)<\/h[1-6]>/gi) || [];
    for (const h of headings) {
        const text = h.replace(/<[^>]+>/g, "").trim();
        for (const word of text.split(/\s+/)) {
            const lower = word.toLowerCase().replace(/[^\w]/g, "");
            if (lower.length > 2) keywords.add(lower);
        }
    }

    // 3. Button labels
    const buttons = content.match(/<button[^>]*>([^<]+)<\/button>/gi) || [];
    for (const b of buttons) {
        const text = b.replace(/<[^>]+>/g, "").trim();
        for (const word of text.split(/\s+/)) {
            const lower = word.toLowerCase().replace(/[^\w]/g, "");
            if (lower.length > 2) keywords.add(lower);
        }
    }

    // 4. id and class names (split by hyphens/underscores)
    const idClassNames = content.match(/(?:id|class)=["']([^"']+)["']/gi) || [];
    for (const attr of idClassNames) {
        const val = attr.match(/=["']([^"']+)["']/)?.[1] || "";
        for (const word of val.split(/[\s\-_]+/)) {
            const lower = word.toLowerCase();
            if (lower.length > 2 && !VERB_PREFIXES.includes(lower)) {
                keywords.add(lower);
            }
        }
    }

    return [...keywords];
}

/**
 * Scan observation buffer for SPEC.md / README.md / requirements .md file writes,
 * and return their cleaned text content. This is the user's actual requirement —
 * the best matching signal for guide discovery.
 */
function extractSpecContent(buf: Observation[]): string {
    const specParts: string[] = [];

    for (const o of buf) {
        if (!o.isWriteAction || !o.fileEdited) continue;
        const fileName = o.fileEdited.split("/").pop()?.toLowerCase() || "";
        // Match SPEC.md, README.md, requirements.md, spec.md etc.
        if (!/\.md$/i.test(fileName)) continue;
        if (!/spec|readme|requirement|design|brief/i.test(fileName)) continue;

        // Extract content from the observation args
        const content = String(o.args?.content || o.result || "");
        if (!content || content.length < 20) continue;

        // Clean markdown — strip headers/formatting, keep the substance
        const cleaned = content
            .replace(/^#{1,6}\s+/gm, "")  // strip heading markers
            .replace(/[*_~`]/g, "")         // strip formatting
            .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")  // links → text
            .replace(/\n{2,}/g, " ")        // collapse newlines
            .trim()
            .substring(0, 500);

        if (cleaned.length > 10) specParts.push(cleaned);
    }

    return specParts.join(" ").substring(0, 800);
}
