# Investigation Plan: Guide Matching Returns "Found 0 matching"

## Problem Statement

When building the exact same project that was previously recorded in memory, the code-buddy plugin logs `Found 0 matching guide(s)` — meaning no stored guides are injected despite a relevant memory existing.

---

## Root Cause Analysis

The guide matching logic lives in `hooks.ts:145-195`. After tracing through the full flow, there are **three structural issues** in the `calculateSimilarity` function (`helpers.ts:59-78`) and how it's used.

### Root Cause 1: Jaccard Similarity Fundamentally Penalizes Short-Query vs Long-Document Comparisons

**This is the primary cause.**

The search context (`searchCtx`) built at `hooks.ts:151-169` is short — typically a filename, a few function names, and maybe an HTML title. Example:

```
"index.html Snake Game drawBoard moveSnake startGame gameLoop"
→ after processing: ~7 unique words
```

The memory being compared against is `title + content` (`hooks.ts:177`), where content can be up to 2000 chars — easily 40-60 unique words after filtering.

Jaccard formula: `intersection / union`

Worked example:
- Search words (7): `{indexhtml, snake, game, drawboard, movesnake, startgame, gameloop}`
- Memory words (50): `{snake, game, css, grid, board, canvas, rendering, ...40 more domain words...}`
- Intersection: 2 (`snake`, `game`)
- Union: 7 + 50 - 2 = 55
- **Score: 2/55 = 0.036** — far below the 0.15 threshold

Even for a perfect topic match, the long memory content inflates the union denominator, making it nearly impossible for a short query to reach 0.15.

### Root Cause 2: CamelCase Function Names Become Non-Matching Single Tokens

The function name extraction regex at `hooks.ts:162` captures names like `drawBoard`, `moveSnake`, `startGame`. The similarity function at `helpers.ts:60-66` lowercases and splits on whitespace only:

```
"drawBoard" → "drawboard" (one token)
```

But in the memory content, these concepts appear as separate words: "draw", "board", "move", "snake", "start", "game". The Jaccard comparison sees `"drawboard"` and `"board"` as completely different words — **zero intersection for what should be a match**.

### Root Cause 3: One-Shot Matching With No Retry

At `hooks.ts:148`, `guidesInjected = true` is set immediately before any scoring. If the first write action is a boilerplate file (package.json, config, etc.) with poor search context, matching fails and **never retries** on subsequent, more informative writes.

---

## Evidence Path: How to Verify Each Cause

### Step 1: Reproduce with logging

Add temporary debug logging inside the guide matching block (`hooks.ts:173-182`) to print:
- The `searchCtx` string and its word set after processing
- Each memory's `title + content` word set
- The computed Jaccard score for each memory
- Confirm scores are all < 0.15

### Step 2: Verify with the similarity test

Write a test case that mirrors the real scenario:
```typescript
// Short search context (what hooks.ts builds)
const searchCtx = "index.html Snake Game drawBoard moveSnake";
// Long memory content (what's actually stored)
const memoryText = "Snake game: CSS grid board with neon theme. Single HTML file with embedded CSS and JS. Uses requestAnimationFrame for game loop. Snake movement via coordinate array tracking x,y positions. Food spawns on random empty cells. Collision detection against walls and body segments.";
const score = calculateSimilarity(searchCtx, memoryText);
// Expected: score << 0.15 due to union inflation
```

### Step 3: Verify CamelCase issue

```typescript
calculateSimilarity("drawBoard moveSnake startGame", "draw board move snake start game");
// Expected: 0.0 — no word overlap despite same concepts
```

### Step 4: Check what memory types are stored

Inspect `~/.config/opencode/code-buddy/data/memory.json` and verify:
- Are stored memories type `"feature"` or `"pattern"`? (only these pass the filter at `hooks.ts:174`)
- Or are they `"note"`, `"lesson"`, `"decision"`, `"bugfix"`? (these would be filtered out entirely)

### Step 5: Check first-write context quality

Log which tool action triggers the first `isWriteAction` and what `searchCtx` is built from it. If the first write is a config/metadata file, the context will be domain-irrelevant.

---

## Summary of Issues (Ranked by Impact)

| # | Issue | Location | Impact |
|---|-------|----------|--------|
| 1 | Jaccard union inflation: short query vs long document | `helpers.ts:59-78`, used at `hooks.ts:177` | **Critical** — mathematically prevents matching even for identical projects |
| 2 | CamelCase tokens don't split into component words | `helpers.ts:60-66` + `hooks.ts:162` | **High** — eliminates word overlap from function names |
| 3 | Single-shot matching, no retry on later writes | `hooks.ts:148` | **Medium** — if first write has poor context, opportunity is lost |
| 4 | Memory type filter may exclude all stored memories | `hooks.ts:174` | **Medium** — if auto-observer stores as "note"/"lesson", filter excludes them |

---

## Potential Fix Directions (For Future Reference — Not Implementing Now)

1. **Normalize the similarity for asymmetric lengths**: Use `intersection / min(|A|, |B|)` (overlap coefficient) instead of Jaccard, or use a weighted blend. This would score 2/7 = 0.29 in the example above — above the 0.15 threshold.

2. **Split CamelCase before comparison**: Add a CamelCase splitter so `drawBoard` → `draw board` before word extraction.

3. **Allow multiple matching attempts**: Don't set `guidesInjected = true` until a match is found or N write actions have been tried.

4. **Widen the type filter**: Include all memory types in guide matching, not just `"feature"` and `"pattern"`.

5. **Compare against title only** (not title + content): Since titles are short (~60 chars), Jaccard would work much better for a short-query-to-short-document comparison.
