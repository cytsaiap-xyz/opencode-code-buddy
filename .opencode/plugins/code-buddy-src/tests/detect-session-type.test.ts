import { describe, it, expect } from "vitest";
import { detectSessionType } from "../dedup";
import { createObservation } from "./mock-state";

describe("detectSessionType", () => {
    it("returns 'build' when write tool is present", () => {
        const buf = [createObservation({ tool: "write", isWriteAction: true })];
        expect(detectSessionType(buf)).toBe("build");
    });

    it("returns 'build' when write + edit tools are present", () => {
        const buf = [
            createObservation({ tool: "write", isWriteAction: true }),
            createObservation({ tool: "edit", isWriteAction: true }),
        ];
        expect(detectSessionType(buf)).toBe("build");
    });

    it("returns 'debug' when edit has debug keywords in result", () => {
        const buf = [
            createObservation({ tool: "read" }),
            createObservation({ tool: "edit", isWriteAction: true, result: "fixing bug in collision detection" }),
        ];
        expect(detectSessionType(buf)).toBe("debug");
    });

    it("returns 'debug' for each debug keyword variant", () => {
        const keywords = ["bug", "fix", "debug", "error", "issue", "broken", "wrong", "crash", "typo", "regression"];
        for (const kw of keywords) {
            const buf = [
                createObservation({ tool: "edit", isWriteAction: true, result: `Resolving ${kw} in module` }),
            ];
            expect(detectSessionType(buf)).toBe("debug");
        }
    });

    it("returns 'enhance' when edits add many net lines (>10)", () => {
        // 15 new lines, 2 old lines = net 13
        const newLines = Array.from({ length: 15 }, (_, i) => `line${i}`).join("\n");
        const buf = [
            createObservation({
                tool: "edit",
                isWriteAction: true,
                args: { old_string: "line1\nline2", new_string: newLines },
            }),
        ];
        expect(detectSessionType(buf)).toBe("enhance");
    });

    it("returns 'enhance' when edit adds a new function", () => {
        const buf = [
            createObservation({
                tool: "edit",
                isWriteAction: true,
                args: {
                    old_string: "// placeholder",
                    new_string: "function togglePause() {\n    isPaused = !isPaused;\n}",
                },
            }),
        ];
        expect(detectSessionType(buf)).toBe("enhance");
    });

    it("returns 'enhance' when edit adds 2+ new HTML elements", () => {
        const buf = [
            createObservation({
                tool: "edit",
                isWriteAction: true,
                args: {
                    old_string: "<div>old</div>",
                    new_string: "<div>old</div>\n<span class=\"stat\">Score</span>\n<canvas id=\"minimap\"></canvas>\n<button>Pause</button>",
                },
            }),
        ];
        expect(detectSessionType(buf)).toBe("enhance");
    });

    it("returns 'debug' for small edit without debug keywords", () => {
        const buf = [
            createObservation({
                tool: "edit",
                isWriteAction: true,
                args: { old_string: "x = 1", new_string: "x = 2" },
            }),
        ];
        expect(detectSessionType(buf)).toBe("debug");
    });

    it("returns 'build' for empty buffer", () => {
        expect(detectSessionType([])).toBe("build");
    });

    it("returns 'build' for read-only observations", () => {
        const buf = [
            createObservation({ tool: "read" }),
            createObservation({ tool: "glob" }),
        ];
        expect(detectSessionType(buf)).toBe("build");
    });

    it("returns 'debug' for exactly 10 net lines (boundary: not > 10)", () => {
        // 12 new lines, 2 old lines = net 10 (exactly at boundary, NOT > 10)
        const newLines = Array.from({ length: 12 }, (_, i) => `line${i}`).join("\n");
        const buf = [
            createObservation({
                tool: "edit",
                isWriteAction: true,
                args: { old_string: "old1\nold2", new_string: newLines },
            }),
        ];
        expect(detectSessionType(buf)).toBe("debug");
    });

    it("returns 'enhance' for 11 net lines (just over boundary)", () => {
        // 13 new lines, 2 old lines = net 11
        const newLines = Array.from({ length: 13 }, (_, i) => `line${i}`).join("\n");
        const buf = [
            createObservation({
                tool: "edit",
                isWriteAction: true,
                args: { old_string: "old1\nold2", new_string: newLines },
            }),
        ];
        expect(detectSessionType(buf)).toBe("enhance");
    });

    it("debug keywords take priority over enhancement signals", () => {
        // Has both: many new lines AND debug keyword
        const newLines = Array.from({ length: 20 }, (_, i) => `line${i}`).join("\n");
        const buf = [
            createObservation({
                tool: "edit",
                isWriteAction: true,
                args: { old_string: "x", new_string: newLines },
                result: "Fixed the broken rendering bug",
            }),
        ];
        expect(detectSessionType(buf)).toBe("debug");
    });
});
