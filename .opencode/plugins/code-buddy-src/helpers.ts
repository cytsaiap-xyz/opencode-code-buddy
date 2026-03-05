/**
 * Pure utility functions — no side effects, no state.
 */

import type { MemoryEntry, MemoryCategory } from "./types";
import { MEMORY_TYPE_CATEGORY } from "./types";

// ---- ID generation ----

export const generateId = (prefix: string): string =>
    `${prefix}_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;

export const generateConfirmCode = (): string =>
    Math.random().toString(36).substring(2, 8).toUpperCase();

// ---- Search ----

/**
 * Case-insensitive text search across multiple fields of an item array.
 * Supports string and string-array fields.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function searchText<T extends Record<string, any>>(
    items: T[],
    query: string,
    fields: string[],
): T[] {
    const lower = query.toLowerCase();
    return items.filter((item) =>
        fields.some((field) => {
            const value = item[field];
            if (typeof value === "string") return value.toLowerCase().includes(lower);
            if (Array.isArray(value)) return value.some((v) => String(v).toLowerCase().includes(lower));
            return false;
        }),
    );
}

// ---- Memory helpers ----

export function getMemoryCategory(memory: MemoryEntry): MemoryCategory {
    return memory.category || MEMORY_TYPE_CATEGORY[memory.type] || "knowledge";
}

// ---- Similarity ----

/**
 * Jaccard similarity on word sets (words > 2 chars).
 * Excludes auto-observer noise words that cause unrelated sessions to match.
 */
const SIMILARITY_STOP_WORDS = new Set([
    "auto", "observed", "task", "error", "bash", "read", "write", "edit",
    "glob", "grep", "skill", "session", "used", "tools", "file", "files",
    "the", "and", "for", "with", "from", "that", "this", "are", "was",
    "merged", "title", "content", "max", "chars", "combine", "key",
    "points", "remove", "duplicates",
    // Spec/requirements noise words
    "should", "must", "will", "need", "create", "build", "implement",
    "feature", "include", "using", "make", "also", "each", "when",
    "have", "been", "into", "like", "some", "only", "about", "more",
    "than", "can", "could", "would",
]);

/** Tokenise text into a word set: strip punctuation, filter noise. No camelCase splitting. */
function toWords(t: string): Set<string> {
    return new Set(
        t
            .toLowerCase()
            .replace(/[^\w\s]/g, "")
            .split(/\s+/)
            .filter((w) => w.length > 2 && !SIMILARITY_STOP_WORDS.has(w)),
    );
}

/** Tokenise with camelCase/PascalCase splitting — only for guide matching queries. */
function toWordsWithCamelSplit(t: string): Set<string> {
    return new Set(
        t
            // Split camelCase/PascalCase BEFORE lowercasing (e.g. drawBoard → draw Board)
            .replace(/([a-z])([A-Z])/g, "$1 $2")
            .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
            .toLowerCase()
            .replace(/[^\w\s]/g, "")
            .split(/\s+/)
            .filter((w) => w.length > 2 && !SIMILARITY_STOP_WORDS.has(w)),
    );
}

/** Jaccard similarity — good for symmetric comparisons (dedup: similar-length texts). */
export function calculateSimilarity(text1: string, text2: string): number {
    const a = toWords(text1);
    const b = toWords(text2);
    if (a.size === 0 || b.size === 0) return 0;

    let intersection = 0;
    for (const w of a) {
        if (b.has(w)) intersection++;
    }
    const union = a.size + b.size - intersection;
    return union > 0 ? intersection / union : 0;
}

/**
 * Overlap coefficient with camelCase splitting — for guide matching only
 * (short search query vs long memory content).
 * Formula: intersection / min(|A|, |B|)
 *
 * CamelCase splitting is applied so function names from code (drawBoard,
 * moveSnake) match separate words in memory content ("draw board", "snake").
 * This is intentionally NOT used for dedup — camelCase splitting inflates
 * scores between different projects that share common patterns.
 */
export function calculateGuideRelevance(query: string, document: string): number {
    const a = toWordsWithCamelSplit(query);
    const b = toWordsWithCamelSplit(document);
    if (a.size === 0 || b.size === 0) return 0;

    let intersection = 0;
    for (const w of a) {
        if (b.has(w)) intersection++;
    }
    const minSize = Math.min(a.size, b.size);
    return minSize > 0 ? intersection / minSize : 0;
}

// ---- Injection sanitization ----

/**
 * Prompt injection patterns to strip from memory content before injection.
 * These patterns are commonly used to manipulate LLM behavior.
 */
const INJECTION_PATTERNS: RegExp[] = [
    // System/instruction override attempts
    /\[?\s*(?:SYSTEM|ADMIN|ROOT)\s*(?:OVERRIDE|PROMPT|MESSAGE|INSTRUCTION)\s*[:\]]/gi,
    /(?:^|\n)\s*(?:ignore|disregard|forget|override|bypass)\s+(?:all\s+)?(?:previous|prior|above|earlier|preceding)\s+(?:instructions?|prompts?|rules?|guidelines?|context)/gi,
    /(?:^|\n)\s*(?:new|updated|revised|corrected)\s+(?:system\s+)?(?:instructions?|prompt|rules?|guidelines?)\s*:/gi,
    /(?:^|\n)\s*you\s+(?:are|must)\s+now\s+(?:a|an)\s+(?:unrestricted|unfiltered|jailbroken|uncensored)/gi,
    // Role reassignment
    /(?:^|\n)\s*(?:from\s+now\s+on|henceforth|going\s+forward)\s*,?\s*(?:you\s+(?:are|will|should|must)|act\s+as|pretend\s+to\s+be|behave\s+as)/gi,
    // Hidden instruction markers
    /<!--\s*(?:SYSTEM|HIDDEN|SECRET|INJECT)\s*[^>]*-->/gi,
    // Fake XML/tag-based injection
    /<\s*(?:system|instruction|override|admin|prompt|role)\s*>/gi,
    /<\s*\/\s*(?:system|instruction|override|admin|prompt|role)\s*>/gi,
];

/**
 * Sanitize text before injecting into chat messages, tool outputs, or compaction context.
 * Strips known prompt injection patterns and wraps the content to clearly mark it as data.
 *
 * This does NOT prevent all attacks — it raises the bar against common patterns.
 */
export function sanitizeForInjection(text: string, maxLen: number): string {
    let cleaned = text.substring(0, maxLen);
    for (const pattern of INJECTION_PATTERNS) {
        cleaned = cleaned.replace(pattern, "[filtered]");
    }
    return cleaned;
}

// ---- Date formatting ----

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Return current time as ISO 8601 string for storage, e.g. "2026-02-24T15:45:00.123Z" */
export function nowTimestamp(): string {
    return new Date().toISOString();
}

/** Parse a timestamp (ISO string or legacy numeric ms) into a Date */
function parseTS(ts: string | number): Date {
    return typeof ts === "number" ? new Date(ts) : new Date(ts);
}

/** Format timestamp as human-readable date, e.g. "Feb 24, 2026" */
export function formatDate(ts: string | number): string {
    const d = parseTS(ts);
    return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

/** Format timestamp as human-readable date+time, e.g. "Feb 24, 2026 3:45 PM" */
export function formatDateTime(ts: string | number): string {
    const d = parseTS(ts);
    const h = d.getHours();
    const m = d.getMinutes().toString().padStart(2, "0");
    const ampm = h >= 12 ? "PM" : "AM";
    const h12 = h % 12 || 12;
    return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()} ${h12}:${m} ${ampm}`;
}

/** Format timestamp as human-readable time, e.g. "3:45 PM" */
export function formatTime(ts: string | number): string {
    const d = parseTS(ts);
    const h = d.getHours();
    const m = d.getMinutes().toString().padStart(2, "0");
    const ampm = h >= 12 ? "PM" : "AM";
    const h12 = h % 12 || 12;
    return `${h12}:${m} ${ampm}`;
}

// ---- Task classification ----

export function detectTaskType(task: string): string {
    const lower = task.toLowerCase();
    if (/implement|build|create|add|feature/.test(lower)) return "implement";
    if (/fix|bug|error|issue/.test(lower)) return "fix";
    if (/refactor|improve|optimize/.test(lower)) return "refactor";
    if (/test|spec/.test(lower)) return "test";
    if (/doc|readme/.test(lower)) return "document";
    if (/research|investigate/.test(lower)) return "research";
    return "task";
}

export function estimateComplexity(task: string): string {
    const wordCount = task.split(/\s+/).length;
    const lower = task.toLowerCase();
    if (wordCount < 10 || /simple|easy|quick/.test(lower)) return "low";
    if (wordCount > 30 || /complex|difficult|large/.test(lower)) return "high";
    return "medium";
}

// ---- Workflow data ----

export const WORKFLOW_STEPS: Record<string, string[]> = {
    idle: ["📋 Define task goals", "🔍 Research existing code", "📝 Create plan"],
    planning: ["📐 Design interfaces", "🏗️ Confirm architecture", "✅ List acceptance criteria"],
    implementing: ["💻 Write core logic", "📝 Add comments", "🧪 Write tests"],
    "code-written": ["🧪 Run tests", "🔍 Check lint", "📖 Update docs"],
    testing: ["✅ Fix failing tests", "📊 Check coverage", "🔄 Iterate"],
    reviewing: ["💬 Address feedback", "🔧 Make changes", "✅ Get approval"],
    "commit-ready": ["📝 Write commit message", "🔄 Update branch", "✅ Commit"],
    deploying: ["🚀 Monitor deploy", "✅ Verify", "🔍 Check production"],
    completed: ["📚 Document lessons", "🎉 Celebrate!", "📋 Next task"],
};

export const WORKFLOW_PROGRESS: Record<string, number> = {
    idle: 0, planning: 10, implementing: 30, "code-written": 50,
    testing: 60, reviewing: 80, "commit-ready": 90, deploying: 98, completed: 100,
};

export const TASK_STEPS: Record<string, string[]> = {
    implement: ["Understand requirements", "Design solution", "Implement code", "Write tests", "Review"],
    fix: ["Reproduce issue", "Analyze root cause", "Implement fix", "Verify fix", "Add regression test"],
    refactor: ["Review current code", "Plan changes", "Refactor incrementally", "Test", "Document"],
    test: ["Identify scenarios", "Write test cases", "Run tests", "Fix failures", "Report"],
    document: ["Identify audience", "Outline content", "Write docs", "Add examples", "Review"],
    research: ["Define scope", "Gather info", "Analyze options", "Document findings", "Recommend"],
    task: ["Clarify goals", "Plan approach", "Execute", "Verify", "Document"],
};
