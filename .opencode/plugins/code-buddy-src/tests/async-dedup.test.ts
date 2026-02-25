import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { addMemoryWithDedup, findSimilarMemories } from "../llm";
import { createMockState, createMemoryEntry } from "./mock-state";

// Mock global fetch to prevent real HTTP calls
const mockFetch = vi.fn();

beforeEach(() => {
    vi.stubGlobal("fetch", mockFetch);
    mockFetch.mockReset();
});

afterEach(() => {
    vi.unstubAllGlobals();
});

/** Helper to make mockFetch return an LLM response. */
function mockLLMResponse(content: string) {
    mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
            choices: [{ message: { content } }],
        }),
    });
}

/** Helper to create a mock state with LLM available. */
function stateWithLLM(memories: ReturnType<typeof createMemoryEntry>[] = []) {
    return createMockState({
        memories,
        resolvedProvider: {
            providerID: "test",
            modelID: "test-model",
            baseURL: "http://localhost:1234/v1",
            apiKey: "test-key",
            name: "test-provider",
        },
    });
}

// ============================================
// findSimilarMemories
// ============================================

describe("findSimilarMemories", () => {
    it("returns empty matches when no memories exist", async () => {
        const s = createMockState({ memories: [] });
        const result = await findSimilarMemories(s, "snake game guide", "Snake Game");
        expect(result.matches).toHaveLength(0);
        expect(result.method).toBe("jaccard");
    });

    it("returns Jaccard matches when above 0.65 threshold", async () => {
        const existing = createMemoryEntry({
            title: "snake game canvas rendering neon theme collision detection guide",
            content: "snake game canvas rendering neon theme collision detection guide detailed",
        });
        const s = createMockState({ memories: [existing] });

        const result = await findSimilarMemories(s,
            "snake game canvas rendering neon theme collision detection guide updated",
            "snake game canvas rendering neon theme guide",
        );

        expect(result.matches).toHaveLength(1);
        expect(result.matches[0]).toBe(existing);
        expect(result.method).toBe("jaccard");
    });

    it("skips LLM when Jaccard match is found", async () => {
        const existing = createMemoryEntry({
            title: "snake game canvas rendering neon theme collision detection guide",
            content: "snake game canvas rendering neon theme collision detection guide detailed",
        });
        const s = stateWithLLM([existing]);

        await findSimilarMemories(s,
            "snake game canvas rendering neon theme collision detection guide updated",
            "snake game canvas rendering neon theme guide",
        );

        // fetch (askAI) should NOT be called since Jaccard matched
        expect(mockFetch).not.toHaveBeenCalled();
    });

    it("falls back to LLM when no Jaccard match and LLM finds similarity", async () => {
        const existing = createMemoryEntry({
            title: "HTML5 canvas game development",
            content: "Building interactive games with canvas API",
        });
        const s = stateWithLLM([existing]);

        // Mock LLM to return "similar"
        mockLLMResponse(JSON.stringify({ similar: true, score: 0.85, reason: "same topic" }));

        const result = await findSimilarMemories(s, "Creating browser games with HTML5", "Web game development");

        expect(result.matches).toHaveLength(1);
        expect(result.method).toBe("llm");
    });

    it("returns empty when LLM score is below 0.75", async () => {
        const existing = createMemoryEntry({
            title: "HTML5 canvas game development",
            content: "Building interactive games with canvas API",
        });
        const s = stateWithLLM([existing]);

        mockLLMResponse(JSON.stringify({ similar: true, score: 0.60, reason: "loosely related" }));

        const result = await findSimilarMemories(s, "Creating browser games", "Web development");

        expect(result.matches).toHaveLength(0);
    });

    it("skips LLM pass when useLLM=false", async () => {
        const existing = createMemoryEntry({
            title: "HTML5 canvas game",
            content: "Canvas game development",
        });
        const s = stateWithLLM([existing]);

        const result = await findSimilarMemories(s, "Different content entirely", "Different title", false);

        expect(result.matches).toHaveLength(0);
        expect(mockFetch).not.toHaveBeenCalled();
    });

    it("skips LLM when provider not available", async () => {
        const existing = createMemoryEntry({
            title: "HTML5 canvas game",
            content: "Canvas game development",
        });
        const s = createMockState({ memories: [existing] }); // no resolvedProvider

        const result = await findSimilarMemories(s, "Different content", "Different title");

        expect(result.matches).toHaveLength(0);
        expect(mockFetch).not.toHaveBeenCalled();
    });

    it("checks only last 10 memories for LLM pass", async () => {
        const memories = Array.from({ length: 15 }, (_, i) =>
            createMemoryEntry({
                id: `mem_${i}`,
                title: `Unique topic ${i} with special keywords`,
                content: `Unique content ${i} about different subject`,
            }),
        );
        const s = stateWithLLM(memories);

        mockLLMResponse(JSON.stringify({ similar: false, score: 0.1, reason: "not similar" }));

        await findSimilarMemories(s, "Completely different", "Unrelated title");

        // Should call fetch 10 times (last 10 memories), not 15
        expect(mockFetch).toHaveBeenCalledTimes(10);
    });

    it("handles LLM returning invalid JSON gracefully", async () => {
        const existing = createMemoryEntry({
            title: "HTML5 canvas game",
            content: "Canvas game development",
        });
        const s = stateWithLLM([existing]);

        mockLLMResponse("This is not JSON at all");

        const result = await findSimilarMemories(s, "Different content", "Different title");

        expect(result.matches).toHaveLength(0);
    });
});

// ============================================
// addMemoryWithDedup
// ============================================

describe("addMemoryWithDedup", () => {
    it("creates new memory when no matches found", async () => {
        const s = createMockState({ memories: [] });
        const result = await addMemoryWithDedup(s, {
            type: "feature",
            category: "knowledge",
            title: "Snake game project guide",
            content: "Canvas-based snake game with neon theme",
            tags: ["snake", "game"],
        });

        expect(result.action).toBe("created");
        expect(result.entry).toBeDefined();
        expect(result.entry!.id).toMatch(/^mem_/);
        expect(result.entry!.timestamp).toBeTruthy();
        expect(s.memories).toHaveLength(1);
    });

    it("increments memoriesCreated counter on create", async () => {
        const s = createMockState({ memories: [] });
        await addMemoryWithDedup(s, {
            type: "note",
            title: "Test memory",
            content: "Test content here",
            tags: ["test"],
        });

        expect(s.session.memoriesCreated).toBe(1);
    });

    it("creates entry bypassing dedup when forceSave=true", async () => {
        const existing = createMemoryEntry({
            title: "snake game canvas rendering neon theme guide detailed",
            content: "snake game canvas rendering neon theme guide detailed content",
        });
        const s = createMockState({ memories: [existing] });

        const result = await addMemoryWithDedup(s, {
            type: "feature",
            title: "snake game canvas rendering neon theme guide detailed v2",
            content: "snake game canvas rendering neon theme guide detailed content updated",
            tags: ["snake"],
        }, true);

        expect(result.action).toBe("created");
        expect(s.memories).toHaveLength(2);
    });

    it("merges with single match when LLM is available", async () => {
        const existing = createMemoryEntry({
            id: "mem_existing_123",
            title: "snake game canvas rendering neon theme collision guide",
            content: "snake game canvas rendering neon theme collision guide original",
            tags: ["snake", "original"],
        });
        const s = stateWithLLM([existing]);

        // Mock the merge LLM call
        mockLLMResponse(JSON.stringify({
            title: "Snake game: canvas rendering with neon theme",
            content: "Comprehensive guide covering canvas rendering and collision detection in snake game",
        }));

        const result = await addMemoryWithDedup(s, {
            type: "feature",
            title: "snake game canvas rendering neon theme collision guide updated",
            content: "snake game canvas rendering neon theme collision guide updated version",
            tags: ["snake", "updated"],
        });

        expect(result.action).toBe("merged");
        expect(s.memories).toHaveLength(1);
        expect(result.entry!.title).toBe("Snake game: canvas rendering with neon theme");
    });

    it("unions tags on merge", async () => {
        const existing = createMemoryEntry({
            title: "snake game canvas rendering neon theme collision guide",
            content: "snake game canvas rendering neon theme collision guide original",
            tags: ["tag-a", "tag-b"],
        });
        const s = stateWithLLM([existing]);

        mockLLMResponse(JSON.stringify({
            title: "Merged guide",
            content: "Merged content",
        }));

        const result = await addMemoryWithDedup(s, {
            type: "feature",
            title: "snake game canvas rendering neon theme collision guide updated",
            content: "snake game canvas rendering neon theme collision guide new",
            tags: ["tag-b", "tag-c"],
        });

        expect(result.action).toBe("merged");
        expect(result.entry!.tags).toContain("tag-a");
        expect(result.entry!.tags).toContain("tag-b");
        expect(result.entry!.tags).toContain("tag-c");
    });

    it("skips when single match found but no LLM available", async () => {
        const existing = createMemoryEntry({
            title: "snake game canvas rendering neon theme collision guide",
            content: "snake game canvas rendering neon theme collision guide original",
        });
        const s = createMockState({ memories: [existing] }); // no provider

        const result = await addMemoryWithDedup(s, {
            type: "feature",
            title: "snake game canvas rendering neon theme collision guide updated",
            content: "snake game canvas rendering neon theme collision guide new",
            tags: ["snake"],
        });

        expect(result.action).toBe("skipped");
        expect(s.memories).toHaveLength(1); // not modified
    });

    it("skips when multiple matches found", async () => {
        const mem1 = createMemoryEntry({
            title: "snake game canvas rendering neon theme collision detection guide",
            content: "snake game canvas rendering neon theme collision detection guide one",
        });
        const mem2 = createMemoryEntry({
            title: "snake game canvas rendering neon theme collision detection guide two",
            content: "snake game canvas rendering neon theme collision detection guide another",
        });
        const s = stateWithLLM([mem1, mem2]);

        const result = await addMemoryWithDedup(s, {
            type: "feature",
            title: "snake game canvas rendering neon theme collision detection guide updated",
            content: "snake game canvas rendering neon theme collision detection guide new",
            tags: ["snake"],
        });

        expect(result.action).toBe("skipped");
        expect(result.similarMemories!.length).toBeGreaterThanOrEqual(2);
    });

    it("uses fallback merge when LLM returns template text", async () => {
        const existing = createMemoryEntry({
            id: "mem_existing",
            title: "snake game canvas rendering neon theme collision guide",
            content: "snake game canvas rendering neon theme collision guide original",
            tags: ["snake"],
        });
        const s = stateWithLLM([existing]);

        // LLM returns bad template text
        mockLLMResponse(JSON.stringify({
            title: "merged title (max 60 chars)",
            content: "combine key points from both entries",
        }));

        const result = await addMemoryWithDedup(s, {
            type: "feature",
            title: "snake game canvas rendering neon theme collision guide new",
            content: "snake game canvas rendering neon theme collision guide updated content",
            tags: ["snake"],
        });

        expect(result.action).toBe("merged");
        // Fallback: title should be the new content's title (not "merged title")
        expect(result.entry!.title).not.toContain("merged title");
    });

    it("uses fallback merge when LLM returns non-JSON", async () => {
        const existing = createMemoryEntry({
            title: "snake game canvas rendering neon theme collision guide",
            content: "Original snake game guide content here",
            tags: ["snake"],
        });
        const s = stateWithLLM([existing]);

        // LLM returns garbage
        mockLLMResponse("Sorry, I cannot merge these memories properly.");

        const result = await addMemoryWithDedup(s, {
            type: "feature",
            title: "snake game canvas rendering neon theme collision guide v2",
            content: "Updated snake game guide content",
            tags: ["snake"],
        });

        expect(result.action).toBe("merged");
        // Fallback content should contain "[Previous]"
        expect(result.entry!.content).toContain("[Previous]");
    });

    it("returns correct method in result", async () => {
        const existing = createMemoryEntry({
            title: "snake game canvas rendering neon theme collision guide",
            content: "snake game canvas rendering neon theme collision guide original",
        });
        const s = createMockState({ memories: [existing] });

        const result = await addMemoryWithDedup(s, {
            type: "feature",
            title: "snake game canvas rendering neon theme collision guide updated",
            content: "snake game canvas rendering neon theme collision guide new version",
            tags: ["snake"],
        });

        // Skipped because Jaccard matched but no LLM
        expect(result.method).toBe("jaccard");
    });

    it("calls saveMemories on successful merge", async () => {
        const existing = createMemoryEntry({
            title: "snake game canvas rendering neon theme collision guide",
            content: "snake game canvas rendering neon theme collision guide original",
        });
        const s = stateWithLLM([existing]);

        mockLLMResponse(JSON.stringify({ title: "Merged", content: "Merged content" }));

        await addMemoryWithDedup(s, {
            type: "feature",
            title: "snake game canvas rendering neon theme collision guide updated",
            content: "snake game canvas rendering neon theme collision guide new",
            tags: ["snake"],
        });

        expect(s.saveMemories).toHaveBeenCalled();
    });
});
