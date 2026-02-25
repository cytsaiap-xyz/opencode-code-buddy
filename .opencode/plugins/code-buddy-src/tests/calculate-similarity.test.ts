import { describe, it, expect } from "vitest";
import { calculateSimilarity } from "../helpers";

describe("calculateSimilarity", () => {
    it("returns 1.0 for identical texts", () => {
        const text = "implementing snake game movement logic";
        expect(calculateSimilarity(text, text)).toBe(1);
    });

    it("returns 0 for completely different texts", () => {
        expect(calculateSimilarity(
            "react component rendering pipeline",
            "database migration deployment scripts",
        )).toBe(0);
    });

    it("returns 0 for empty string vs content", () => {
        expect(calculateSimilarity("", "some real content here")).toBe(0);
    });

    it("returns 0 for both empty strings", () => {
        expect(calculateSimilarity("", "")).toBe(0);
    });

    it("excludes stop words from comparison", () => {
        // All words in SIMILARITY_STOP_WORDS: "auto", "observed", "task", "error", "file", "session"
        expect(calculateSimilarity(
            "auto observed task error file session",
            "auto observed task error file session",
        )).toBe(0);
    });

    it("filters out short words (<=2 chars)", () => {
        // "I", "am", "a", "go", "to", "is" are all <=2 chars
        expect(calculateSimilarity("I am a go to is", "I am a go to is")).toBe(0);
    });

    it("is case insensitive", () => {
        expect(calculateSimilarity("Snake Game Canvas", "snake game canvas")).toBe(1);
    });

    it("strips punctuation", () => {
        const score1 = calculateSimilarity("fix: memory-leak in useEffect()", "hello world");
        const score2 = calculateSimilarity("fix memory leak in useEffect", "hello world");
        expect(score1).toBe(score2);
    });

    it("returns partial overlap score for shared words", () => {
        // Craft: 5 shared words out of 9 unique (after stop word filtering)
        // shared: alpha, bravo, charlie, delta, echo (all >2 chars, not stop words)
        const shared = "alpha bravo charlie delta echo";
        const text1 = `${shared} foxtrot golf hotel india`;
        const text2 = `${shared} juliet kilo lima mike`;
        // intersection = 5, union = 5 + 4 + 4 - 5 = 9? No: set1 = {alpha,bravo,charlie,delta,echo,foxtrot,golf,hotel,india} (9), set2 = {alpha,bravo,charlie,delta,echo,juliet,kilo,lima,mike} (9)
        // intersection = 5, union = 9 + 9 - 5 = 13... wait, that's wrong. union = |A ∪ B| = |A| + |B| - |A ∩ B| = 9 + 9 - 5 = 13
        // But wait, each set has 9 unique words. union = 13. score = 5/13 ≈ 0.385
        // Hmm, need to recalculate. Let me use different numbers.
        const score = calculateSimilarity(text1, text2);
        expect(score).toBeGreaterThan(0);
        expect(score).toBeLessThan(1);
    });

    it("scores in sync dedup range (>= 0.55) for similar project descriptions", () => {
        // 6 shared out of 10 unique words total
        // set1 = {snake, game, canvas, rendering, neon, theme, collision, detection} = 8 words
        // set2 = {snake, game, canvas, rendering, neon, theme, score, board} = 8 words
        // intersection = 6, union = 8 + 8 - 6 = 10, score = 6/10 = 0.6
        const text1 = "snake game canvas rendering neon theme collision detection";
        const text2 = "snake game canvas rendering neon theme score board";
        const score = calculateSimilarity(text1, text2);
        expect(score).toBeGreaterThanOrEqual(0.55);
        expect(score).toBeLessThan(0.65);
    });

    it("scores above async threshold (>= 0.65) for very similar texts", () => {
        // 7 shared out of 9 unique
        // set1 = {snake, game, canvas, rendering, neon, theme, movement, logic} = 8
        // set2 = {snake, game, canvas, rendering, neon, theme, movement, controls} = 8
        // intersection = 7, union = 8 + 8 - 7 = 9, score = 7/9 ≈ 0.778
        const text1 = "snake game canvas rendering neon theme movement logic";
        const text2 = "snake game canvas rendering neon theme movement controls";
        const score = calculateSimilarity(text1, text2);
        expect(score).toBeGreaterThanOrEqual(0.65);
    });

    it("scores below sync threshold (< 0.55) for loosely related texts", () => {
        // 3 shared out of ~10+ unique
        // set1 = {snake, game, canvas, rendering, animation, loop, physics} = 7
        // set2 = {snake, game, canvas, dropdown, modal, button, header, footer} = 8
        // intersection = 3, union = 7 + 8 - 3 = 12, score = 3/12 = 0.25
        const text1 = "snake game canvas rendering animation loop physics";
        const text2 = "snake game canvas dropdown modal button header footer";
        const score = calculateSimilarity(text1, text2);
        expect(score).toBeLessThan(0.55);
    });
});
