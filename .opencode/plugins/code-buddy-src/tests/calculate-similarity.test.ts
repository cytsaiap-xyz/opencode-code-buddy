import { describe, it, expect } from "vitest";
import { calculateSimilarity, calculateGuideRelevance } from "../helpers";

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

    it("excludes spec/requirements noise words from comparison", () => {
        // All words from the new spec noise additions
        expect(calculateSimilarity(
            "should must will need create build implement feature include using make",
            "should must will need create build implement feature include using make",
        )).toBe(0);
        expect(calculateSimilarity(
            "also each when have been into like some only about more than can could would",
            "also each when have been into like some only about more than can could would",
        )).toBe(0);
    });

    it("is case insensitive", () => {
        expect(calculateSimilarity("Snake Game Canvas", "snake game canvas")).toBe(1);
    });

    it("strips punctuation", () => {
        const score1 = calculateSimilarity("fix: memory-leak in useEffect()", "hello world");
        const score2 = calculateSimilarity("fix memory leak in useEffect", "hello world");
        expect(score1).toBe(score2);
    });

    it("does NOT split camelCase — preserves dedup safety", () => {
        // camelCase tokens should stay joined so different projects sharing
        // common patterns (drawBoard, startGame) don't false-match in dedup
        const score = calculateSimilarity("drawBoard moveSnake", "draw board move snake");
        expect(score).toBe(0); // "drawboard" ≠ "draw", "movesnake" ≠ "move"
    });

    it("returns partial overlap score for shared words", () => {
        const shared = "alpha bravo charlie delta echo";
        const text1 = `${shared} foxtrot golf hotel india`;
        const text2 = `${shared} juliet kilo lima mike`;
        const score = calculateSimilarity(text1, text2);
        expect(score).toBeGreaterThan(0);
        expect(score).toBeLessThan(1);
    });

    it("scores in sync dedup range (>= 0.55) for similar project descriptions", () => {
        const text1 = "snake game canvas rendering neon theme collision detection";
        const text2 = "snake game canvas rendering neon theme score board";
        const score = calculateSimilarity(text1, text2);
        expect(score).toBeGreaterThanOrEqual(0.55);
        expect(score).toBeLessThan(0.65);
    });

    it("scores above async threshold (>= 0.65) for very similar texts", () => {
        const text1 = "snake game canvas rendering neon theme movement logic";
        const text2 = "snake game canvas rendering neon theme movement controls";
        const score = calculateSimilarity(text1, text2);
        expect(score).toBeGreaterThanOrEqual(0.65);
    });

    it("scores below sync threshold (< 0.55) for loosely related texts", () => {
        const text1 = "snake game canvas rendering animation loop physics";
        const text2 = "snake game canvas dropdown modal button header footer";
        const score = calculateSimilarity(text1, text2);
        expect(score).toBeLessThan(0.55);
    });

    it("keeps different projects below dedup threshold despite shared patterns", () => {
        // Snake and Tetris share common function-name patterns — without camelCase
        // splitting, the joined tokens (drawboard, startgame, etc.) stay unique to
        // each context and don't inflate the score.
        const snake = "Snake game drawBoard moveSnake startGame gameLoop checkCollision updateScore";
        const tetris = "Tetris game drawBoard movePiece startGame gameLoop checkLines updateScore";
        const score = calculateSimilarity(snake, tetris);
        // Should stay below async dedup threshold (0.65)
        expect(score).toBeLessThan(0.65);
    });
});

describe("calculateGuideRelevance", () => {
    it("returns 1.0 for identical texts", () => {
        const text = "snake game canvas rendering";
        expect(calculateGuideRelevance(text, text)).toBe(1);
    });

    it("returns 0 for completely different texts", () => {
        expect(calculateGuideRelevance(
            "react component pipeline",
            "database migration scripts",
        )).toBe(0);
    });

    it("returns 0 for empty inputs", () => {
        expect(calculateGuideRelevance("", "some content")).toBe(0);
        expect(calculateGuideRelevance("some content", "")).toBe(0);
        expect(calculateGuideRelevance("", "")).toBe(0);
    });

    it("handles short query vs long document — the key fix", () => {
        // This is the exact scenario that was broken: a short search context from the
        // first write action compared against a long memory content.
        const shortQuery = "index.html Snake Game drawBoard moveSnake startGame gameLoop";
        const longMemory = "Snake game: CSS grid board with neon theme. Single HTML file with embedded CSS and JS. " +
            "Uses requestAnimationFrame for game loop. Snake movement via coordinate array tracking x,y positions. " +
            "Food spawns on random empty cells. Collision detection against walls and body segments. " +
            "Score display updated on each food pickup. Neon green theme with dark background.";

        const relevance = calculateGuideRelevance(shortQuery, longMemory);
        const jaccard = calculateSimilarity(shortQuery, longMemory);

        // Overlap coefficient should score well above 0.15 threshold
        expect(relevance).toBeGreaterThanOrEqual(0.15);
        // Jaccard would have failed (score too low due to union inflation)
        expect(jaccard).toBeLessThan(0.15);
    });

    it("scores higher than Jaccard for asymmetric lengths", () => {
        const query = "snake game canvas";
        const document = "snake game canvas rendering neon theme collision detection movement controls scoring food spawn";

        const relevance = calculateGuideRelevance(query, document);
        const jaccard = calculateSimilarity(query, document);

        // Overlap: 3/3 = 1.0 (all query words found in document)
        // Jaccard: 3/12 = 0.25 (diluted by document length)
        expect(relevance).toBeGreaterThan(jaccard);
        expect(relevance).toBe(1); // all query words present in document
    });

    it("scores proportionally to query word coverage", () => {
        const document = "snake game canvas rendering neon theme";

        // 2 out of 4 query words match → ~0.5
        const score1 = calculateGuideRelevance("snake game react database", document);
        // 3 out of 4 query words match → ~0.75
        const score2 = calculateGuideRelevance("snake game canvas database", document);

        expect(score2).toBeGreaterThan(score1);
        expect(score1).toBeCloseTo(0.5, 1);
        expect(score2).toBeCloseTo(0.75, 1);
    });

    it("benefits from camelCase splitting for function name matching", () => {
        const query = "drawBoard moveSnake startGame";
        const document = "Snake game with draw board function. Move snake across grid. Start game initializes state.";

        const relevance = calculateGuideRelevance(query, document);
        // After camelCase split: query has {draw, board, move, snake, start, game}
        // Document has {snake, game, draw, board, function, move, across, grid, start, initializes, state}
        // All 6 query words found in document → 6/6 = 1.0
        expect(relevance).toBe(1);
    });
});
