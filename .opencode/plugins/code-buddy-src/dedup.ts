/**
 * Dedup/merge logic extracted from hooks.ts for testability.
 */

import type { MemoryEntry, Observation } from "./types";
import { calculateSimilarity } from "./helpers";
import type { PluginState } from "./state";

export const SYNC_JACCARD_THRESHOLD = 0.55; // slightly lower than async (0.65) to catch project rebuilds

/** Detect whether this is a debug/fix, enhance, or build/create session. */
export function detectSessionType(buf: Observation[]): "debug" | "enhance" | "build" {
    const hasNewFiles = buf.some((o) => o.tool.toLowerCase().includes("write") || o.tool === "write");
    const hasEdits = buf.some((o) => o.tool.toLowerCase().includes("edit") || o.tool === "edit");

    // If new files are written, it's a build
    if (hasNewFiles) return "build";

    // No new files — it's either debug or enhance.
    // Check for explicit debug/fix keywords first.
    const debugKeywords = /\b(bug|fix|debug|error|issue|broken|wrong|incorrect|missing|patch|crash|typo|regression)\b/i;
    const hasDebugContext = buf.some((o) => o.result && debugKeywords.test(o.result));
    if (hasDebugContext && hasEdits) return "debug";

    // Enhancement signals: substantial new code added via edits
    if (hasEdits) {
        let totalAdded = 0;
        let totalRemoved = 0;
        let newFunctions = 0;
        let newElements = 0;

        for (const o of buf) {
            if (!(o.tool === "edit" || o.tool.toLowerCase().includes("edit"))) continue;
            const newStr = (o.args?.new_string || o.args?.newString || o.args?.new || "") as string;
            const oldStr = (o.args?.old_string || o.args?.oldString || o.args?.old || "") as string;

            totalAdded += newStr.split("\n").length;
            totalRemoved += oldStr.split("\n").length;

            // Count new functions/methods added
            const newFuncMatches = newStr.match(/function\s+\w+/g) || [];
            const oldFuncMatches = oldStr.match(/function\s+\w+/g) || [];
            newFunctions += Math.max(0, newFuncMatches.length - oldFuncMatches.length);

            // Count new HTML elements added
            const newElemMatches = newStr.match(/<\w+[\s>]/g) || [];
            const oldElemMatches = oldStr.match(/<\w+[\s>]/g) || [];
            newElements += Math.max(0, newElemMatches.length - oldElemMatches.length);
        }

        // Enhancement: significantly more lines added than removed, or new functions/elements
        const netAdded = totalAdded - totalRemoved;
        if (netAdded > 10 || newFunctions >= 1 || newElements >= 2) {
            return "enhance";
        }
    }

    // Small targeted edits without debug keywords — still classify as debug (small fix)
    if (hasEdits) return "debug";

    return "build";
}

/**
 * Sync dedup: check Jaccard similarity and merge if a match is found.
 * Used by sync flush paths (process exit) where async LLM calls aren't possible.
 * - If a similar memory exists → update it in-place (merge content, union tags, bump timestamp).
 * - If no match → push a new entry.
 * Returns the saved/merged entry.
 */
export function saveMemoryWithSyncDedup(
    s: PluginState,
    entry: MemoryEntry,
): MemoryEntry {
    const combined = `${entry.title} ${entry.content}`;

    // Find the best Jaccard match
    let bestIdx = -1;
    let bestScore = 0;
    for (let i = 0; i < s.memories.length; i++) {
        const m = s.memories[i];
        const score = calculateSimilarity(combined, `${m.title} ${m.content}`);
        if (score >= SYNC_JACCARD_THRESHOLD && score > bestScore) {
            bestScore = score;
            bestIdx = i;
        }
    }

    if (bestIdx >= 0) {
        const existing = s.memories[bestIdx];
        s.log(`[code-buddy] 🔄 Sync dedup: merging with "${existing.title}" (Jaccard: ${bestScore.toFixed(2)})`);

        // Merge: new content replaces old (it's more up-to-date), union tags
        existing.title = entry.title;
        existing.content = entry.content;
        existing.timestamp = entry.timestamp;
        existing.tags = [...new Set([...existing.tags, ...entry.tags])].slice(0, 10);

        s.saveMemories();
        return existing;
    }

    // No match — save as new
    s.memories.push(entry);
    s.saveMemories();
    return entry;
}
