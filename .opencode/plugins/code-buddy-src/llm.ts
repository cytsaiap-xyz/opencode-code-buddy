/**
 * LLM provider resolution, AI calls, and memory deduplication/merge.
 */

import type { MemoryEntry, MemoryType, ProviderInfo, DedupResult } from "./types";
import { MEMORY_TYPE_CATEGORY } from "./types";
import { calculateSimilarity, generateId } from "./helpers";
import type { PluginState } from "./state";

// ============================================
// Provider Resolution
// ============================================

export async function resolveProvider(s: PluginState): Promise<ProviderInfo | null> {
    if (s.resolvedProvider) return s.resolvedProvider;

    try {
        const result = await s.client.config.providers();
        if (!result.data) return null;

        const providers = result.data.providers || [];
        if (providers.length === 0) return null;

        let target: any = null;
        if (s.config.llm.preferredProvider) {
            target = providers.find((p: any) => p.id === s.config.llm.preferredProvider);
        }
        if (!target) target = providers[0];
        if (!target) return null;

        const modelKeys = Object.keys(target.models || {});
        let modelID = "";
        if (s.config.llm.preferredModel && modelKeys.includes(s.config.llm.preferredModel)) {
            modelID = s.config.llm.preferredModel;
        } else if (modelKeys.length > 0) {
            modelID = modelKeys[0];
        } else {
            return null;
        }

        s.resolvedProvider = {
            providerID: target.id,
            modelID,
            baseURL: String(target.options?.baseURL || target.options?.baseUrl || ""),
            apiKey: String(target.key || target.options?.apiKey || ""),
            name: target.name || target.id,
        };

        s.log(`[code-buddy] Resolved provider: ${s.resolvedProvider.name} (${s.resolvedProvider.modelID})`);
        return s.resolvedProvider;
    } catch (error) {
        s.log("[code-buddy] Error resolving provider:", error);
        return null;
    }
}

export async function isLLMAvailable(s: PluginState): Promise<boolean> {
    const p = await resolveProvider(s);
    return !!(p && p.baseURL && p.apiKey);
}

export async function getLLMStatus(s: PluginState): Promise<string> {
    const p = await resolveProvider(s);
    if (p) return `Connected (${p.name}: ${p.modelID})`;
    return "No provider configured — using OpenCode's built-in AI";
}

// ============================================
// AI Calls
// ============================================

export async function askAI(s: PluginState, prompt: string): Promise<string> {
    const provider = await resolveProvider(s);

    if (provider?.baseURL && provider.apiKey) {
        try {
            const response = await fetch(`${provider.baseURL}/chat/completions`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${provider.apiKey}`,
                },
                body: JSON.stringify({
                    model: provider.modelID,
                    messages: [{ role: "user", content: prompt }],
                    max_tokens: s.config.llm.maxTokens,
                    temperature: s.config.llm.temperature,
                }),
            });

            if (response.ok) {
                const data = (await response.json()) as { choices: Array<{ message: { content: string } }> };
                if (data.choices?.[0]?.message?.content) {
                    return data.choices[0].message.content;
                }
            } else {
                s.log(`[code-buddy] LLM API error: ${response.status} ${response.statusText}`);
            }
        } catch (error) {
            s.log("[code-buddy] LLM API call error:", error);
        }
    }

    // Fallback: return a structured prompt for OpenCode's built-in AI
    return `[AI Analysis Request]\n\nPlease analyze and respond to the following:\n\n${prompt}\n\n---\nNote: This is a buddy_ask_ai tool call. Please provide a helpful response based on your knowledge.`;
}

/** Extract the first JSON object from a string, or null. */
export function extractJSON(text: string): any | null {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
        try { return JSON.parse(match[0]); } catch { /* ignore */ }
    }
    return null;
}

/** Extract the first JSON array from a string, or null. */
export function extractJSONArray(text: string): any[] | null {
    const match = text.match(/\[[\s\S]*\]/);
    if (match) {
        try {
            const arr = JSON.parse(match[0]);
            return Array.isArray(arr) ? arr : null;
        } catch { /* ignore */ }
    }
    return null;
}

// ============================================
// Semantic Similarity (LLM-based)
// ============================================

async function checkSemanticSimilarity(
    s: PluginState,
    text1: string,
    text2: string,
): Promise<{ similar: boolean; score: number; reason: string }> {
    if (!(await isLLMAvailable(s))) {
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
        const response = await askAI(s, prompt);
        const parsed = extractJSON(response);
        if (parsed) {
            return {
                similar: parsed.similar === true,
                score: typeof parsed.score === "number" ? parsed.score : 0,
                reason: parsed.reason || "",
            };
        }
    } catch (error) {
        s.log("[code-buddy] Semantic similarity error:", error);
    }
    return { similar: false, score: 0, reason: "Parse error" };
}

// ============================================
// Deduplication & Merge
// ============================================

const JACCARD_THRESHOLD = 0.35;
const LLM_SIMILARITY_THRESHOLD = 0.6;

export async function findSimilarMemories(
    s: PluginState,
    content: string,
    title: string,
    useLLM = true,
): Promise<{ matches: MemoryEntry[]; method: "jaccard" | "llm" }> {
    const combined = `${title} ${content}`;

    // First pass: Jaccard
    const jaccardMatches = s.memories.filter(
        (m) => calculateSimilarity(combined, `${m.title} ${m.content}`) >= JACCARD_THRESHOLD,
    );
    if (jaccardMatches.length > 0) {
        return { matches: jaccardMatches, method: "jaccard" };
    }

    // Second pass: LLM semantic check on last 10 memories
    if (useLLM && (await isLLMAvailable(s)) && s.memories.length > 0) {
        const candidates = s.memories.slice(-10);
        const llmMatches: MemoryEntry[] = [];

        for (const m of candidates) {
            const result = await checkSemanticSimilarity(s, combined, `${m.title} ${m.content}`);
            if (result.similar && result.score >= LLM_SIMILARITY_THRESHOLD) {
                llmMatches.push(m);
                s.log(`[code-buddy] LLM found similar: ${m.title} (${result.score}, ${result.reason})`);
            }
        }
        if (llmMatches.length > 0) {
            return { matches: llmMatches, method: "llm" };
        }
    }

    return { matches: [], method: "jaccard" };
}

async function mergeMemoriesWithAI(
    s: PluginState,
    existing: MemoryEntry,
    newContent: { title: string; content: string },
): Promise<{ title: string; content: string }> {
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
        const response = await askAI(s, prompt);
        const parsed = extractJSON(response);
        if (parsed?.title && parsed.content) return parsed;
    } catch (error) {
        s.log("[code-buddy] Merge error:", error);
    }

    // Fallback: simple concatenation
    return {
        title: newContent.title,
        content: `${existing.content}\n\n---\n[Updated] ${newContent.content}`,
    };
}

/**
 * Add a memory with deduplication. If a similar memory exists:
 * - 1 match + LLM available → auto-merge
 * - otherwise → skip and report
 */
export async function addMemoryWithDedup(
    s: PluginState,
    entry: Omit<MemoryEntry, "id" | "timestamp">,
    forceSave = false,
): Promise<DedupResult> {
    const similarResult = await findSimilarMemories(s, entry.content, entry.title, !forceSave);
    const similar = similarResult.matches;

    if (similar.length === 0 || forceSave) {
        const newEntry: MemoryEntry = { ...entry, id: generateId("mem"), timestamp: Date.now() };
        s.memories.push(newEntry);
        s.saveMemories();
        s.session.memoriesCreated++;
        return { action: "created", entry: newEntry, message: `✅ Memory created: **${entry.title}**` };
    }

    // Try LLM merge when exactly one match
    if (similar.length === 1 && (await isLLMAvailable(s))) {
        const merged = await mergeMemoriesWithAI(s, similar[0], { title: entry.title, content: entry.content });
        const idx = s.memories.findIndex((m) => m.id === similar[0].id);
        if (idx >= 0) {
            s.memories[idx].title = merged.title;
            s.memories[idx].content = merged.content;
            s.memories[idx].timestamp = Date.now();
            s.memories[idx].tags = [...new Set([...s.memories[idx].tags, ...entry.tags])];
            s.saveMemories();
            return {
                action: "merged",
                entry: s.memories[idx],
                similarMemories: similar,
                method: similarResult.method,
                message: `🔄 Memory merged with existing (${similarResult.method}): **${merged.title}**`,
            };
        }
    }

    return {
        action: "skipped",
        similarMemories: similar,
        method: similarResult.method,
        message: `⚠️ Found ${similar.length} similar memor${similar.length === 1 ? "y" : "ies"} (via ${similarResult.method}). Use \`forceSave: true\` to save anyway.`,
    };
}

/** Generate tags via LLM, falling back to keyword extraction from the title. */
export async function autoGenerateTags(s: PluginState, title: string, content: string, type: string): Promise<string[]> {
    try {
        const prompt = `Generate 3-5 relevant tags for this memory entry. Tags should be lowercase, hyphenated, concise.

Title: ${title}
Content: ${content}
Type: ${type}

Respond ONLY with a JSON array of strings, e.g. ["tag-one", "tag-two", "tag-three"]`;
        const response = await askAI(s, prompt);
        const tags = extractJSONArray(response);
        if (tags && tags.length > 0) return tags;
    } catch { /* fallback below */ }

    // Fallback: extract keywords from title
    return title.toLowerCase().split(/\s+/).filter((w) => w.length > 3).slice(0, 3);
}
