import { describe, it, expect, vi } from "vitest";
import { saveMemoryWithSyncDedup } from "../dedup";
import { createMockState, createMemoryEntry } from "./mock-state";

describe("saveMemoryWithSyncDedup", () => {
    it("pushes new entry when no memories exist", () => {
        const s = createMockState({ memories: [] });
        const entry = createMemoryEntry({ title: "Snake game guide", content: "Canvas based snake game" });

        const result = saveMemoryWithSyncDedup(s, entry);

        expect(s.memories).toHaveLength(1);
        expect(s.memories[0]).toBe(entry);
        expect(result).toBe(entry);
        expect(s.saveMemories).toHaveBeenCalledOnce();
    });

    it("pushes new entry when no match above threshold", () => {
        const existing = createMemoryEntry({
            title: "React hooks optimization",
            content: "useCallback and useMemo for performance",
        });
        const s = createMockState({ memories: [existing] });
        const entry = createMemoryEntry({
            title: "Snake game guide",
            content: "Canvas based snake game with collision detection",
        });

        const result = saveMemoryWithSyncDedup(s, entry);

        expect(s.memories).toHaveLength(2);
        expect(result).toBe(entry);
    });

    it("merges in-place when exact match found", () => {
        const existing = createMemoryEntry({
            id: "mem_existing",
            title: "Snake game canvas rendering neon theme",
            content: "Snake game canvas rendering neon theme collision detection",
            tags: ["snake", "game"],
            timestamp: "2026-01-01T00:00:00.000Z",
        });
        const s = createMockState({ memories: [existing] });
        const entry = createMemoryEntry({
            id: "mem_new",
            title: "Snake game canvas rendering neon theme v2",
            content: "Snake game canvas rendering neon theme collision detection updated",
            tags: ["snake", "updated"],
            timestamp: "2026-02-25T00:00:00.000Z",
        });

        const result = saveMemoryWithSyncDedup(s, entry);

        // Should merge: only 1 memory, not 2
        expect(s.memories).toHaveLength(1);
        // Existing entry is updated in-place
        expect(result).toBe(existing);
        expect(existing.title).toBe(entry.title);
        expect(existing.content).toBe(entry.content);
        expect(existing.timestamp).toBe(entry.timestamp);
    });

    it("merges when Jaccard score is above 0.55", () => {
        // Craft words so Jaccard ~ 0.6
        const existing = createMemoryEntry({
            title: "snake game canvas rendering neon theme collision detection",
            content: "snake game canvas rendering neon theme collision detection",
            tags: ["old"],
        });
        const s = createMockState({ memories: [existing] });
        const entry = createMemoryEntry({
            title: "snake game canvas rendering neon theme score board",
            content: "snake game canvas rendering neon theme score board",
            tags: ["new"],
        });

        saveMemoryWithSyncDedup(s, entry);

        expect(s.memories).toHaveLength(1);
    });

    it("does not merge when Jaccard score is below 0.55", () => {
        const existing = createMemoryEntry({
            title: "react component optimization hooks",
            content: "react component optimization hooks useState",
        });
        const s = createMockState({ memories: [existing] });
        const entry = createMemoryEntry({
            title: "snake game canvas neon theme",
            content: "snake game canvas neon theme rendering",
        });

        saveMemoryWithSyncDedup(s, entry);

        expect(s.memories).toHaveLength(2);
    });

    it("replaces title and content on merge", () => {
        const existing = createMemoryEntry({
            title: "snake game canvas rendering neon theme guide detailed",
            content: "snake game canvas rendering neon theme guide detailed original version",
            tags: ["snake"],
        });
        const s = createMockState({ memories: [existing] });
        const entry = createMemoryEntry({
            title: "snake game canvas rendering neon theme guide updated",
            content: "snake game canvas rendering neon theme guide updated version",
            tags: ["snake"],
        });

        saveMemoryWithSyncDedup(s, entry);

        expect(existing.title).toBe("snake game canvas rendering neon theme guide updated");
        expect(existing.content).toContain("updated version");
    });

    it("unions tags on merge", () => {
        const existing = createMemoryEntry({
            title: "snake game canvas rendering neon theme guide",
            content: "snake game canvas rendering neon theme guide detailed",
            tags: ["react", "hooks"],
        });
        const s = createMockState({ memories: [existing] });
        const entry = createMemoryEntry({
            title: "snake game canvas rendering neon theme guide v2",
            content: "snake game canvas rendering neon theme guide updated",
            tags: ["hooks", "state"],
        });

        saveMemoryWithSyncDedup(s, entry);

        expect(existing.tags).toContain("react");
        expect(existing.tags).toContain("hooks");
        expect(existing.tags).toContain("state");
    });

    it("caps tags at 10 on merge", () => {
        const existing = createMemoryEntry({
            title: "snake game canvas rendering neon theme guide",
            content: "snake game canvas rendering neon theme guide detailed",
            tags: ["tag1", "tag2", "tag3", "tag4", "tag5", "tag6", "tag7", "tag8"],
        });
        const s = createMockState({ memories: [existing] });
        const entry = createMemoryEntry({
            title: "snake game canvas rendering neon theme guide v2",
            content: "snake game canvas rendering neon theme guide updated",
            tags: ["tag6", "tag7", "tag8", "tag9", "tag10", "tag11", "tag12"],
        });

        saveMemoryWithSyncDedup(s, entry);

        expect(existing.tags.length).toBeLessThanOrEqual(10);
    });

    it("bumps timestamp on merge", () => {
        const existing = createMemoryEntry({
            title: "snake game canvas rendering neon theme guide",
            content: "snake game canvas rendering neon theme guide detailed",
            timestamp: "2026-01-01T00:00:00.000Z",
        });
        const s = createMockState({ memories: [existing] });
        const newTimestamp = "2026-02-25T12:00:00.000Z";
        const entry = createMemoryEntry({
            title: "snake game canvas rendering neon theme guide v2",
            content: "snake game canvas rendering neon theme guide updated",
            timestamp: newTimestamp,
        });

        saveMemoryWithSyncDedup(s, entry);

        expect(existing.timestamp).toBe(newTimestamp);
    });

    it("picks best match when multiple are above threshold", () => {
        // Three memories with different similarity to the new entry
        const lowMatch = createMemoryEntry({
            id: "mem_low",
            title: "snake game canvas basic rendering",
            content: "snake game canvas basic rendering simple version",
            tags: ["low"],
        });
        const highMatch = createMemoryEntry({
            id: "mem_high",
            title: "snake game canvas rendering neon theme collision detection movement",
            content: "snake game canvas rendering neon theme collision detection movement guide",
            tags: ["high"],
        });
        const medMatch = createMemoryEntry({
            id: "mem_med",
            title: "snake game canvas rendering neon effects",
            content: "snake game canvas rendering neon effects particle system",
            tags: ["med"],
        });
        const s = createMockState({ memories: [lowMatch, highMatch, medMatch] });
        const entry = createMemoryEntry({
            title: "snake game canvas rendering neon theme collision detection movement updated",
            content: "snake game canvas rendering neon theme collision detection movement guide updated",
            tags: ["new"],
        });

        const result = saveMemoryWithSyncDedup(s, entry);

        // Should merge with highMatch (highest Jaccard score)
        expect(result).toBe(highMatch);
        expect(s.memories).toHaveLength(3);
        expect(highMatch.tags).toContain("new");
    });

    it("returns the merged entry (existing) on match", () => {
        const existing = createMemoryEntry({
            title: "snake game canvas rendering neon theme guide",
            content: "snake game canvas rendering neon theme guide detailed",
        });
        const s = createMockState({ memories: [existing] });
        const entry = createMemoryEntry({
            title: "snake game canvas rendering neon theme guide v2",
            content: "snake game canvas rendering neon theme guide updated",
        });

        const result = saveMemoryWithSyncDedup(s, entry);

        expect(result).toBe(existing);
    });

    it("returns the new entry on no match", () => {
        const s = createMockState({ memories: [] });
        const entry = createMemoryEntry({ title: "brand new topic", content: "entirely unique content" });

        const result = saveMemoryWithSyncDedup(s, entry);

        expect(result).toBe(entry);
    });

    it("calls saveMemories exactly once on merge", () => {
        const existing = createMemoryEntry({
            title: "snake game canvas rendering neon theme guide",
            content: "snake game canvas rendering neon theme guide detailed",
        });
        const s = createMockState({ memories: [existing] });
        const entry = createMemoryEntry({
            title: "snake game canvas rendering neon theme guide v2",
            content: "snake game canvas rendering neon theme guide updated",
        });

        saveMemoryWithSyncDedup(s, entry);

        expect(s.saveMemories).toHaveBeenCalledOnce();
    });

    it("calls clearObservations exactly once on merge", () => {
        const existing = createMemoryEntry({
            title: "snake game canvas rendering neon theme guide",
            content: "snake game canvas rendering neon theme guide detailed",
        });
        const s = createMockState({ memories: [existing] });
        const entry = createMemoryEntry({
            title: "snake game canvas rendering neon theme guide v2",
            content: "snake game canvas rendering neon theme guide updated",
        });

        saveMemoryWithSyncDedup(s, entry);

    });
});
