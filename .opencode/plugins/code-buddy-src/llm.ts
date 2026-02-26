/**
 * LLM provider resolution, AI calls, and memory deduplication/merge.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { MemoryEntry, MemoryType, ProviderInfo, DedupResult } from "./types";
import { MEMORY_TYPE_CATEGORY } from "./types";
import { calculateSimilarity, generateId, nowTimestamp } from "./helpers";
import type { PluginState } from "./state";

// ============================================
// Provider Resolution
// ============================================

/**
 * Read the first provider from an opencode.json file.
 * Returns null if the file doesn't exist or has no providers.
 */
function readProviderFromOpenCodeJson(filePath: string, s: PluginState): ProviderInfo | null {
    try {
        if (!fs.existsSync(filePath)) return null;

        const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
        const providerMap = raw.provider;
        if (!providerMap || typeof providerMap !== "object") return null;

        const providerIds = Object.keys(providerMap);
        if (providerIds.length === 0) return null;

        // Pick preferred provider if configured, otherwise first available
        let targetId = providerIds[0];
        if (s.config.llm.preferredProvider && providerIds.includes(s.config.llm.preferredProvider)) {
            targetId = s.config.llm.preferredProvider;
        }

        const cfg = providerMap[targetId];
        if (!cfg) return null;

        const modelKeys = Object.keys(cfg.models || {});
        let modelID = "";
        if (s.config.llm.preferredModel && modelKeys.includes(s.config.llm.preferredModel)) {
            modelID = s.config.llm.preferredModel;
        } else if (modelKeys.length > 0) {
            modelID = modelKeys[0];
        }

        // Also check the top-level "model" field (format: "provider/model")
        if (!modelID && raw.model && typeof raw.model === "string") {
            const parts = raw.model.split("/");
            if (parts.length === 2 && parts[0] === targetId) {
                modelID = parts[1];
            } else if (parts.length === 2 && !providerIds.includes(parts[0])) {
                // model field references a different provider; skip
            } else if (parts.length === 1) {
                modelID = parts[0];
            }
        }

        if (!modelID) return null;

        const baseURL = String(cfg.options?.baseURL || cfg.options?.baseUrl || cfg.api || "");
        const apiKey = String(cfg.options?.apiKey || "");
        const headers: Record<string, string> | undefined =
            cfg.options?.headers && typeof cfg.options.headers === "object"
                ? cfg.options.headers as Record<string, string>
                : undefined;

        if (!baseURL && !apiKey) return null;

        s.log(`[code-buddy] Resolved provider from ${filePath}: ${cfg.name || targetId} (${modelID})`);
        return {
            providerID: cfg.id || targetId,
            modelID,
            baseURL,
            apiKey,
            name: cfg.name || targetId,
            headers,
        };
    } catch (error) {
        s.log(`[code-buddy] Error reading ${filePath}:`, error);
        return null;
    }
}

export async function resolveProvider(s: PluginState): Promise<ProviderInfo | null> {
    if (s.resolvedProvider) return s.resolvedProvider;

    // Step 1: Try opencode.json in current working directory
    const localConfig = path.join(process.cwd(), "opencode.json");
    const fromLocal = readProviderFromOpenCodeJson(localConfig, s);
    if (fromLocal) {
        s.resolvedProvider = fromLocal;
        return s.resolvedProvider;
    }

    // Step 2: Try ~/.config/opencode/opencode.json
    const globalConfig = path.join(os.homedir(), ".config", "opencode", "opencode.json");
    const fromGlobal = readProviderFromOpenCodeJson(globalConfig, s);
    if (fromGlobal) {
        s.resolvedProvider = fromGlobal;
        return s.resolvedProvider;
    }

    s.log("[code-buddy] No LLM provider found (local opencode.json or global opencode.json)");
    return null;
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

/**
 * Startup connectivity test — sends a simple "HI" to the LLM and validates
 * that a non-empty response comes back. Logs success/failure with latency.
 * Returns the result so callers can inspect it if needed.
 */
export async function testLLMConnection(s: PluginState): Promise<{
    ok: boolean;
    latencyMs: number;
    provider?: string;
    model?: string;
    reply?: string;
    error?: string;
}> {
    const provider = await resolveProvider(s);

    if (!provider?.baseURL || !provider.apiKey) {
        const msg = "No LLM provider configured — skipping connectivity test";
        s.log(`[code-buddy] ⚠️ ${msg}`);
        return { ok: false, latencyMs: 0, error: msg };
    }

    const startTime = Date.now();
    try {
        const response = await fetch(`${provider.baseURL}/chat/completions`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${provider.apiKey}`,
                ...(provider.headers || {}),
            },
            body: JSON.stringify({
                model: provider.modelID,
                messages: [{ role: "user", content: "HI" }],
                max_tokens: 10,
                temperature: 0,
            }),
        });

        const latencyMs = Date.now() - startTime;

        if (!response.ok) {
            const error = `HTTP ${response.status} ${response.statusText}`;
            s.log(`[code-buddy] ❌ LLM connection test FAILED (${provider.name}/${provider.modelID}) — ${error} (${latencyMs}ms)`);
            return { ok: false, latencyMs, provider: provider.name, model: provider.modelID, error };
        }

        const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
        const reply = data.choices?.[0]?.message?.content?.trim() || "";

        if (reply.length === 0) {
            const error = "Empty response from LLM";
            s.log(`[code-buddy] ❌ LLM connection test FAILED (${provider.name}/${provider.modelID}) — ${error} (${latencyMs}ms)`);
            return { ok: false, latencyMs, provider: provider.name, model: provider.modelID, error };
        }

        s.log(`[code-buddy] ✅ LLM connection test OK (${provider.name}/${provider.modelID}) — "${reply.substring(0, 50)}" (${latencyMs}ms)`);
        return { ok: true, latencyMs, provider: provider.name, model: provider.modelID, reply };
    } catch (err: any) {
        const latencyMs = Date.now() - startTime;
        const error = err.message || String(err);
        s.log(`[code-buddy] ❌ LLM connection test FAILED (${provider.name}/${provider.modelID}) — ${error} (${latencyMs}ms)`);
        return { ok: false, latencyMs, provider: provider.name, model: provider.modelID, error };
    }
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
                    ...(provider.headers || {}),
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

const JACCARD_THRESHOLD = 0.65;
const LLM_SIMILARITY_THRESHOLD = 0.75;

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
    const prompt = `Merge these two related memories into one concise entry. The merged title must be specific and descriptive (max 60 chars). The merged content must combine concrete details from both, removing duplicates.

EXISTING:
Title: ${existing.title}
Content: ${existing.content}

NEW:
Title: ${newContent.title}
Content: ${newContent.content}

Rules:
- The title MUST describe the actual work (e.g. "Snake game: canvas rendering with neon theme"). Never use generic text.
- The content MUST contain specific details — file names, functions, CSS properties, etc.
- Do NOT repeat the word "merged" or any instructions in your output.

Respond with ONLY a JSON object containing "title" and "content" keys.`;

    try {
        const response = await askAI(s, prompt);
        const parsed = extractJSON(response);
        if (parsed?.title && parsed.content) {
            // Guard against LLM echoing template/placeholder text
            const badPatterns = /^merged (title|content)|max \d+ chars|combine key points|remove duplicates/i;
            if (badPatterns.test(parsed.title) || badPatterns.test(parsed.content)) {
                s.log("[code-buddy] LLM returned template text in merge — using fallback");
            } else {
                return parsed;
            }
        }
    } catch (error) {
        s.log("[code-buddy] Merge error:", error);
    }

    // Fallback: use the newer content entirely (it's more up-to-date).
    // Do NOT concatenate with "[Previous]" — that compounds garbage when both
    // entries are low-quality rule-based outputs (e.g. "Changes: <!DOCTYPE html>").
    return {
        title: newContent.title.substring(0, 60),
        content: newContent.content,
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
        const newEntry: MemoryEntry = { ...entry, id: generateId("mem"), timestamp: nowTimestamp() };
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
            s.memories[idx].timestamp = nowTimestamp();
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
