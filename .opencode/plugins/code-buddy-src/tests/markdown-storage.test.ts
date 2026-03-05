import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MarkdownStorage } from "../markdown-storage";
import type { MemoryEntry, Entity, Relation, MistakeRecord } from "../types";

let tmpDir: string;
let storage: MarkdownStorage;

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "buddy-md-test-"));
    storage = new MarkdownStorage(tmpDir);
});

afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("MarkdownStorage: memories", () => {
    const entry: MemoryEntry = {
        id: "mem_test_001",
        type: "bugfix",
        category: "solution",
        title: "Fix auth timeout",
        content: "Increased JWT expiry from 1h to 24h due to race condition.",
        tags: ["auth", "jwt"],
        timestamp: "2026-03-05T10:00:00.000Z",
    };

    it("should write and read back a memory entry", () => {
        storage.writeMemories([entry]);
        const result = storage.readMemories();
        expect(result).toHaveLength(1);
        expect(result[0].id).toBe("mem_test_001");
        expect(result[0].type).toBe("bugfix");
        expect(result[0].title).toBe("Fix auth timeout");
        expect(result[0].content).toBe("Increased JWT expiry from 1h to 24h due to race condition.");
        expect(result[0].tags).toEqual(["auth", "jwt"]);
    });

    it("should create .md files in entries/ directory", () => {
        storage.writeMemories([entry]);
        const files = fs.readdirSync(path.join(tmpDir, "entries"));
        expect(files.length).toBe(1);
        expect(files[0]).toMatch(/\.md$/);
    });

    it("should create index.yaml", () => {
        storage.writeMemories([entry]);
        expect(fs.existsSync(path.join(tmpDir, "index.yaml"))).toBe(true);
        const content = fs.readFileSync(path.join(tmpDir, "index.yaml"), "utf-8");
        expect(content).toContain("mem_test_001");
        expect(content).toContain("bugfix");
    });

    it("should handle multiple entries", () => {
        const entries: MemoryEntry[] = [
            entry,
            { ...entry, id: "mem_test_002", title: "Add rate limiting", type: "feature", category: "knowledge", tags: ["api"] },
        ];
        storage.writeMemories(entries);
        const result = storage.readMemories();
        expect(result).toHaveLength(2);
    });

    it("should remove deleted entries from disk", () => {
        storage.writeMemories([entry, { ...entry, id: "mem_test_002", title: "Temp entry" }]);
        expect(fs.readdirSync(path.join(tmpDir, "entries")).length).toBe(2);

        // Write only one entry — the other file should be deleted
        storage.writeMemories([entry]);
        expect(fs.readdirSync(path.join(tmpDir, "entries")).length).toBe(1);
    });

    it("should handle empty memories array", () => {
        storage.writeMemories([]);
        const result = storage.readMemories();
        expect(result).toHaveLength(0);
    });

    it("should produce human-readable markdown", () => {
        storage.writeMemories([entry]);
        const files = fs.readdirSync(path.join(tmpDir, "entries"));
        const content = fs.readFileSync(path.join(tmpDir, "entries", files[0]), "utf-8");

        // Should have frontmatter
        expect(content).toMatch(/^---\n/);
        expect(content).toContain("type: bugfix");
        expect(content).toContain("tags: [auth, jwt]");

        // Should have markdown body
        expect(content).toContain("## Fix auth timeout");
        expect(content).toContain("Increased JWT expiry");
    });
});

describe("MarkdownStorage: knowledge graph", () => {
    const entity: Entity = {
        id: "entity_AuthService",
        name: "AuthService",
        type: "component",
        observations: ["Handles JWT tokens", "Uses RS256"],
        tags: ["auth", "security"],
        createdAt: "2026-03-01T00:00:00.000Z",
    };

    const relation: Relation = {
        id: "rel_0",
        from: "AuthService",
        to: "UserModel",
        type: "depends_on",
        description: "Queries user records",
        createdAt: "2026-03-01T00:00:00.000Z",
    };

    it("should write and read entities", () => {
        storage.writeEntities([entity]);
        const result = storage.readEntities();
        expect(result).toHaveLength(1);
        expect(result[0].name).toBe("AuthService");
        expect(result[0].type).toBe("component");
        expect(result[0].observations).toEqual(["Handles JWT tokens", "Uses RS256"]);
        expect(result[0].tags).toEqual(["auth", "security"]);
    });

    it("should write and read relations", () => {
        // Need entities first for writeRelations to create the graph file
        storage.writeEntities([entity]);
        storage.writeRelations([relation]);
        const result = storage.readRelations();
        expect(result).toHaveLength(1);
        expect(result[0].from).toBe("AuthService");
        expect(result[0].to).toBe("UserModel");
        expect(result[0].type).toBe("depends_on");
    });

    it("should store graph in graph.yaml", () => {
        storage.writeEntities([entity]);
        const graphPath = path.join(tmpDir, "graph.yaml");
        expect(fs.existsSync(graphPath)).toBe(true);
        const content = fs.readFileSync(graphPath, "utf-8");
        expect(content).toContain("AuthService:");
        expect(content).toContain("type: component");
    });
});

describe("MarkdownStorage: mistakes", () => {
    const mistake: MistakeRecord = {
        id: "mistake_test_001",
        timestamp: "2026-03-05T10:00:00.000Z",
        action: "Used wrong env variable",
        errorType: "assumption-error",
        userCorrection: "The app reads DATABASE_URL not DB_URL",
        correctMethod: "Check .env.example for canonical names",
        impact: "2 hours debugging",
        preventionMethod: "Verify env var names before deployment",
    };

    it("should write and read mistakes", () => {
        storage.writeMistakes([mistake]);
        const result = storage.readMistakes();
        expect(result).toHaveLength(1);
        expect(result[0].id).toBe("mistake_test_001");
        expect(result[0].errorType).toBe("assumption-error");
        expect(result[0].action).toBe("Used wrong env variable");
        expect(result[0].correctMethod).toBe("Check .env.example for canonical names");
    });

    it("should create .md files in mistakes/ directory", () => {
        storage.writeMistakes([mistake]);
        const files = fs.readdirSync(path.join(tmpDir, "mistakes"));
        expect(files.length).toBe(1);
        expect(files[0]).toMatch(/\.md$/);
    });
});
