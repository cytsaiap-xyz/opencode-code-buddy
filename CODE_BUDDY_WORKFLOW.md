# Code Buddy Plugin — ASCII Workflow

## Full Plugin Overview

```
╔══════════════════════════════════════════════════════════════════════════════════╗
║                        CODE BUDDY PLUGIN — WORKFLOW                            ║
╚══════════════════════════════════════════════════════════════════════════════════╝


  ┌─────────────────────────────────────────────────────────────────────┐
  │                     1. INITIALIZATION                              │
  └─────────────────────────────────────────────────────────────────────┘

      OpenCode starts
           │
           ▼
  ┌─────────────────┐     ┌──────────────────┐     ┌──────────────────┐
  │  Load config    │────▶│  Create Storage  │────▶│  Load State from │
  │  (config.json)  │     │  (LocalStorage)  │     │  JSON data files │
  └─────────────────┘     └──────────────────┘     └──────────────────┘
                                                           │
                          ┌────────────────────────────────┘
                          ▼
                ┌───────────────────┐
                │  Initialize:      │
                │  · memories[]     │
                │  · entities[]     │
                │  · relations[]    │
                │  · mistakes[]     │
                │  · session state  │
                └────────┬──────────┘
                         │
              ┌──────────┴──────────┐
              ▼                     ▼
     ┌──────────────┐     ┌──────────────┐
     │ Register 21  │     │ Register     │
     │ Tools        │     │ Event Hooks  │
     └──────────────┘     └──────────────┘
```


## Deep Dive: Auto-Observer Workflow

```
╔══════════════════════════════════════════════════════════════════════════════════╗
║                  AUTO-OBSERVER — DETAILED WORKFLOW                             ║
║                  (hooks.ts: tool.execute.after)                                ║
╚══════════════════════════════════════════════════════════════════════════════════╝


 ┌──────────────────────────────────────────────────────────────────────────────┐
 │  PHASE 1: OBSERVATION CAPTURE  (runs after EVERY tool execution)            │
 └──────────────────────────────────────────────────────────────────────────────┘

   Any tool finishes execution
        │
        ▼
  ┌──────────────┐  NO
  │ autoObserve  │──────▶  RETURN (feature disabled)
  │ enabled?     │
  └──────┬───────┘
         │ YES
         ▼
  ┌──────────────────────────────────────────────────┐
  │  FILTER: Should we observe this tool?            │
  │                                                  │
  │  ┌──────────────────┐  YES                       │
  │  │ tool starts with │──────▶ SKIP                │
  │  │ "buddy_" ?       │        (don't observe      │
  │  └──────┬───────────┘         our own tools)     │
  │         │ NO                                     │
  │  ┌──────────────────┐  YES                       │
  │  │ tool in ignore   │──────▶ SKIP                │
  │  │ list?            │  (buddy_remember,          │
  │  └──────┬───────────┘   buddy_help, etc.)        │
  │         │ NO                                     │
  │         ▼                                        │
  │       PROCEED                                    │
  └──────────────────────────────────────────────────┘
         │
         ▼
  ┌──────────────────────────────────────────────────────────────────────┐
  │  DETECT: What kind of action was this?                              │
  │                                                                     │
  │   ┌─────────────────────────────────────────┐                       │
  │   │ ERROR DETECTION (regex on output)       │                       │
  │   │                                         │                       │
  │   │ Pattern:                                │                       │
  │   │   /\b(error|Error|ERROR|failed|FAILED|  │                       │
  │   │      FAIL|exception|Exception|panic|    │                       │
  │   │      fatal|Fatal|ENOENT|EACCES|         │                       │
  │   │      TypeError|ReferenceError|          │                       │
  │   │      SyntaxError)\b/                    │                       │
  │   │                                         │                       │
  │   │ hasError = config.autoErrorDetect       │                       │
  │   │           && pattern.test(outputStr)     │                       │
  │   └─────────────────────────────────────────┘                       │
  │                                                                     │
  │   ┌─────────────────────────────────────────┐                       │
  │   │ WRITE-ACTION DETECTION                  │                       │
  │   │                                         │                       │
  │   │ Is tool name one of:                    │                       │
  │   │   edit, write, create, delete, remove,  │                       │
  │   │   move, rename, bash, shell, terminal,  │                       │
  │   │   exec, run, insert, replace, patch,    │                       │
  │   │   apply                                 │                       │
  │   │                                         │                       │
  │   │ OR does metadata contain a file path?   │                       │
  │   │   (meta.filePath, args.file_path, etc.) │                       │
  │   │                                         │                       │
  │   │ OR does title match                     │                       │
  │   │   /Write|Edit|Create|Read <filepath>/?  │                       │
  │   └─────────────────────────────────────────┘                       │
  │                                                                     │
  │   ┌─────────────────────────────────────────┐                       │
  │   │ FILE PATH EXTRACTION                    │                       │
  │   │                                         │                       │
  │   │ Sources tried (in order):               │                       │
  │   │  1. meta.filePath / meta.path / meta.file│                      │
  │   │  2. args.filePath / args.file_path       │                      │
  │   │  3. Title regex: "Edit src/foo.ts"       │                      │
  │   └─────────────────────────────────────────┘                       │
  └──────────────────────────────────────────────────────────────────────┘
         │
         ▼
  ┌──────────────────────────────────────────────────┐
  │  BUFFER: Push observation                        │
  │                                                  │
  │  s.pushObservation({                             │
  │    timestamp:    "2026-03-03T10:15:00.123Z",     │
  │    tool:         "Edit",                         │
  │    args:         { filePath: "src/app.ts", ... },│
  │    result:       outputStr.substring(0, 800),    │  ◀── 800 chars
  │    hasError:     false,                          │      for writes,
  │    fileEdited:   "src/app.ts",                   │      300 for reads
  │    isWriteAction: true,                          │
  │  })                                              │
  │                                                  │
  │  Max buffer size: 50 observations                │
  └──────────────────────────────────────────────────┘
         │
         │
         ▼
  ═══════════════════════════════════════════════════
  ║  THEN: Guide Injection runs (see next diagram) ║
  ═══════════════════════════════════════════════════



 ┌──────────────────────────────────────────────────────────────────────────────┐
 │  PHASE 2: FLUSH — TURN OBSERVATIONS INTO MEMORIES                           │
 │  (triggered by session.idle, session.deleted, or process exit)               │
 └──────────────────────────────────────────────────────────────────────────────┘


   Event fires: session.idle / session.deleted / process.exit
        │
        ▼
  ┌──────────────┐  YES
  │ Already      │──────▶ RETURN (prevent double-flush)
  │ flushing?    │
  └──────┬───────┘
         │ NO (flushState == "idle")
         ▼
  ┌──────────────────────────────────────────────────────────────────┐
  │  GATE 1: Enough observations?                                   │
  │                                                                  │
  │  ┌─────────────────────────┐  NO                                 │
  │  │ buffer.length >=        │──────▶ RETURN                       │
  │  │ observeMinActions (3)?  │        (not enough data)            │
  │  └────────────┬────────────┘                                     │
  │               │ YES                                              │
  │               ▼                                                  │
  │  GATE 2: Was anything meaningful done?                           │
  │  (only if requireEditForRecord = true)                          │
  │                                                                  │
  │  ┌─────────────────────────┐  NO                                 │
  │  │ Any write action OR     │──────▶ RETURN                       │
  │  │ any error detected?     │   "Read-only session, skip record"  │
  │  └────────────┬────────────┘                                     │
  │               │ YES                                              │
  └───────────────┼──────────────────────────────────────────────────┘
                  │
                  ▼
  ┌──────────────────────────┐
  │ config.hooks.fullAuto ?  │
  └──┬───────────────────┬───┘
     │ YES               │ NO
     ▼                   ▼

  ┌───────────────────────────────────────────────────────────────┐
  │  FULL AUTO MODE (processFullAutoObserver)                     │
  │  LLM classifies observations into 1-3 knowledge entries      │
  │                                                               │
  │  1. Build observation summary:                                │
  │     [10:15 AM] Edit (filePath: src/app.ts, ...)               │
  │       → file content preview...                               │
  │     [10:16 AM] Bash (command: npm test) ❌ ERROR              │
  │       → TypeError: Cannot read property...                    │
  │                                                               │
  │  2. Send LLM prompt asking for knowledge extraction:          │
  │     "Extract mental model, design decisions, gotchas,         │
  │      conventions, project status..."                          │
  │                                                               │
  │  3. Parse JSON response:                                      │
  │     { intent: "task-execution",                               │
  │       entries: [                                              │
  │         { category: "task",                                   │
  │           title: "Snake: array-based movement",              │
  │           summary: "Snake is an array of {x,y}...",          │
  │           type: "feature",                                   │
  │           tags: ["state-as-array", "grid-movement"] },       │
  │         { category: "error",                                 │
  │           title: "Gotcha: off-by-one in collision",          │
  │           summary: "...",                                    │
  │           type: "bugfix",                                    │
  │           errorInfo: { pattern, solution, prevention } }     │
  │       ]                                                       │
  │     }                                                         │
  │                                                               │
  │  4. If LLM fails → buildFallbackEntries() (rule-based):      │
  │     ┌───────────────────────────────────────────────────┐     │
  │     │ classifyIntent():                                 │     │
  │     │   errors ≥ 2           → "debugging" / bugfix     │     │
  │     │   reads > writes × 2  → "exploration" / note      │     │
  │     │   edits > creates      → "refactoring" / pattern  │     │
  │     │   has edits            → "task-execution" / feature│     │
  │     │                                                   │     │
  │     │ analyzeFileContent():                             │     │
  │     │   Read files from disk, detect game loops,        │     │
  │     │   state patterns, layout strategy, etc.           │     │
  │     │                                                   │     │
  │     │ refineWithLLM():                                  │     │
  │     │   Clean rule-extracted summary (if LLM avail)     │     │
  │     └───────────────────────────────────────────────────┘     │
  └──────────────────────────────┬────────────────────────────────┘
                                 │
  ┌──────────────────────────────┼────────────────────────────────┐
  │  SINGLE SUMMARY MODE         │(processSingleSummaryObserver)  │
  │  Same LLM prompt, but asks   │for exactly 1 entry             │
  │  Fallback: same rule-based   │classifyIntent + refineWithLLM  │
  └──────────────────────────────┼────────────────────────────────┘
                                 │
                                 ▼
  ┌──────────────────────────────────────────────────────────────────┐
  │  FOR EACH ENTRY (max 4):                                        │
  │                                                                  │
  │    ┌────────────────────────────────────────────────────────┐    │
  │    │  addMemoryWithDedup(entry, forceSave=false)            │    │
  │    │                                                        │    │
  │    │  Step 1: Jaccard similarity (word overlap)             │    │
  │    │  ┌────────────────────────────┐                        │    │
  │    │  │ For each existing memory:  │                        │    │
  │    │  │  words(new) ∩ words(old)   │                        │    │
  │    │  │  ─────────────────────── ≥ 0.65 ?                  │    │
  │    │  │  words(new) ∪ words(old)   │                        │    │
  │    │  │                            │                        │    │
  │    │  │  (stop words filtered:     │                        │    │
  │    │  │   "auto", "task", "file",  │                        │    │
  │    │  │   "should", "create", etc.)│                        │    │
  │    │  └──────────┬─────────────────┘                        │    │
  │    │        MATCH│       NO MATCH                           │    │
  │    │             │           │                              │    │
  │    │             │  Step 2: LLM semantic similarity         │    │
  │    │             │  ┌────────────────────────────┐          │    │
  │    │             │  │ Ask LLM: "Are these texts  │          │    │
  │    │             │  │ semantically similar?"      │          │    │
  │    │             │  │                             │          │    │
  │    │             │  │ Check last 10 memories      │          │    │
  │    │             │  │ Score ≥ 0.75 → MATCH        │          │    │
  │    │             │  └─────┬──────────────┬────────┘          │    │
  │    │             │   MATCH│         NO MATCH                │    │
  │    │             │        │              │                   │    │
  │    │      ┌──────┴────────┘              ▼                  │    │
  │    │      ▼                     ┌──────────────┐            │    │
  │    │  ┌──────────────────┐      │ SAVE AS NEW  │            │    │
  │    │  │ MERGE            │      │ memory entry │            │    │
  │    │  │                  │      └──────────────┘            │    │
  │    │  │ If LLM avail:   │                                  │    │
  │    │  │   Ask LLM to    │                                  │    │
  │    │  │   merge content  │                                  │    │
  │    │  │                  │                                  │    │
  │    │  │ Fallback:        │                                  │    │
  │    │  │   Keep newer     │                                  │    │
  │    │  │   title+content  │                                  │    │
  │    │  │   Union tags     │                                  │    │
  │    │  └──────────────────┘                                  │    │
  │    └────────────────────────────────────────────────────────┘    │
  │                                                                  │
  │    If entry.category == "error" && autoErrorDetect:              │
  │    ┌────────────────────────────────────────────────┐            │
  │    │  Also push to s.mistakes[] and save to         │            │
  │    │  mistakes.json with:                           │            │
  │    │    · pattern:    what went wrong               │            │
  │    │    · solution:   how it was fixed              │            │
  │    │    · prevention: how to avoid it               │            │
  │    └────────────────────────────────────────────────┘            │
  │                                                                  │
  │  Clear observation buffer                                        │
  └──────────────────────────────────────────────────────────────────┘



 ┌──────────────────────────────────────────────────────────────────────────────┐
 │  PHASE 2b: SYNC FLUSH (process exit safety net)                             │
 │  (hooks.ts: process.beforeExit / process.exit)                              │
 └──────────────────────────────────────────────────────────────────────────────┘

   Process exiting (opencode run completes)
        │
        ▼
  ┌──────────────┐  YES
  │ Async flush  │──────▶ RETURN (already done)
  │ completed?   │
  └──────┬───────┘
         │ NO
         ▼
  ┌──────────────────────────────────────────────────────────────────┐
  │  flushObservationsSync(s)  — NO async, NO LLM                   │
  │                                                                  │
  │  1. Same gates: buffer ≥ min, has writes or errors               │
  │  2. classifyIntent() — rule-based only                           │
  │  3. analyzeFileContent() — read files from disk                  │
  │  4. saveMemoryWithSyncDedup():                                   │
  │     ┌────────────────────────────────────┐                       │
  │     │  Jaccard threshold: 0.55 (higher   │                       │
  │     │  than async to avoid false merges   │                       │
  │     │  without LLM confirmation)          │                       │
  │     │                                     │                       │
  │     │  MATCH → merge in-place (update     │                       │
  │     │          title, content, union tags) │                       │
  │     │  NO MATCH → push as new entry       │                       │
  │     └────────────────────────────────────┘                       │
  │  5. fs.writeFileSync() → memory.json                             │
  └──────────────────────────────────────────────────────────────────┘
```


## Deep Dive: Guide Injection Workflow

```
╔══════════════════════════════════════════════════════════════════════════════════╗
║                  GUIDE INJECTION — DETAILED WORKFLOW                           ║
║                  (hooks.ts:147-211, helpers.ts:113-124)                        ║
╚══════════════════════════════════════════════════════════════════════════════════╝

  PURPOSE: When the AI edits a code file, automatically inject relevant
  memories (project guides) into the tool output so the AI "remembers"
  past decisions, conventions, and gotchas while working.


   tool.execute.after fires (observation already buffered)
        │
        ▼
  ┌──────────────────────────────────────────────────────────────────┐
  │  GATE: Should we attempt guide injection?                        │
  │                                                                  │
  │  ALL of these must be true:                                      │
  │                                                                  │
  │  ┌──────────────────────────────┐ NO                             │
  │  │ guidesInjected == false ?    │────▶ SKIP                      │
  │  │ (only inject once per        │  (already injected this        │
  │  │  session)                    │   session — don't spam)        │
  │  └──────────────┬───────────────┘                                │
  │                 │ YES                                            │
  │  ┌──────────────────────────────┐ NO                             │
  │  │ fileEdited is set?           │────▶ SKIP                      │
  │  │ (a file was written/edited)  │  (bash ls, grep, etc.         │
  │  └──────────────┬───────────────┘   have no file context)       │
  │                 │ YES                                            │
  │  ┌──────────────────────────────┐ NO                             │
  │  │ File extension is code?      │────▶ SKIP                      │
  │  │                              │  (.md, .json, .yaml, .txt     │
  │  │ Allowed: html, js, ts, jsx,  │   have poor search context    │
  │  │ tsx, css, scss, py, go, rs,  │   and would match wrong       │
  │  │ java, cpp, c, rb, php,       │   guides)                     │
  │  │ svelte, vue                  │                                │
  │  └──────────────┬───────────────┘                                │
  │                 │ YES                                            │
  │  ┌──────────────────────────────┐ NO                             │
  │  │ s.memories.length > 0 ?      │────▶ SKIP                      │
  │  │ (have memories to search)    │  (nothing to inject)           │
  │  └──────────────┬───────────────┘                                │
  │                 │ YES                                            │
  │  ┌──────────────────────────────┐ NO                             │
  │  │ guideMatchAttempts < 3 ?     │────▶ SKIP                      │
  │  │ (MAX_GUIDE_MATCH_ATTEMPTS)   │  (tried 3 times, give up —   │
  │  └──────────────┬───────────────┘   early writes may be config  │
  │                 │ YES               files with poor context)    │
  │                 ▼                                                │
  │           ALL GATES PASSED                                       │
  └──────────────────────────────────────────────────────────────────┘
        │
        ▼  guideMatchAttempts++
  ┌──────────────────────────────────────────────────────────────────┐
  │  BUILD SEARCH CONTEXT (what to search memories for)              │
  │                                                                  │
  │  Combine signals from best → worst:                              │
  │                                                                  │
  │  ┌─── Signal 1: SPEC.md content (best) ───────────────────────┐ │
  │  │                                                             │ │
  │  │  extractSpecContent(observationBuffer):                     │ │
  │  │    Scan buffer for SPEC.md / README.md / requirements.md    │ │
  │  │    that were WRITTEN in this session                        │ │
  │  │                                                             │ │
  │  │    Clean markdown → strip headers, formatting, links        │ │
  │  │    Return up to 800 chars of spec text                      │ │
  │  │                                                             │ │
  │  │    Example: "Build a snake game with arrow key controls,    │ │
  │  │    score tracking, and increasing difficulty..."            │ │
  │  └─────────────────────────────────────────────────────────────┘ │
  │                                                                  │
  │  ┌─── Signal 2: Domain keywords from code ────────────────────┐ │
  │  │                                                             │ │
  │  │  extractDomainKeywords(fileContent):                        │ │
  │  │                                                             │ │
  │  │    a) Domain objects from identifiers:                      │ │
  │  │       Split camelCase → "drawBoard" → "draw", "board"      │ │
  │  │       Strip verb prefixes (get, set, handle, render...)     │ │
  │  │       Keep nouns: "board", "snake", "food", "score"         │ │
  │  │                                                             │ │
  │  │    b) HTML headings: <h1>Snake Game</h1> → "snake", "game" │ │
  │  │                                                             │ │
  │  │    c) Button labels: <button>New Game</button> → "new",    │ │
  │  │                      "game"                                 │ │
  │  │                                                             │ │
  │  │    d) id/class names: class="game-board" → "game", "board" │ │
  │  └─────────────────────────────────────────────────────────────┘ │
  │                                                                  │
  │  ┌─── Signal 3: HTML <title> ─────────────────────────────────┐ │
  │  │  <title>Snake Game</title> → "Snake Game"                   │ │
  │  └─────────────────────────────────────────────────────────────┘ │
  │                                                                  │
  │  ┌─── Signal 4: Fallback (only if signals 1-3 empty) ────────┐ │
  │  │  · File name: "game.ts" → "game"                           │ │
  │  │  · Function names: function moveSnake → "moveSnake"        │ │
  │  │  · Tool title: "Edit src/game.ts"                          │ │
  │  └─────────────────────────────────────────────────────────────┘ │
  │                                                                  │
  │  searchCtx = all signals joined by spaces                        │
  └──────────────────────────────────────────────────────────────────┘
        │
        ▼
  ┌──────────────────────────────────────────────────────────────────┐
  │  SEARCH: Score each memory against search context                │
  │                                                                  │
  │  For each memory in s.memories[]:                                │
  │                                                                  │
  │    score = calculateGuideRelevance(searchCtx, memory.title+content)
  │                                                                  │
  │    ┌─────────────────────────────────────────────────────┐       │
  │    │  calculateGuideRelevance() — Overlap Coefficient    │       │
  │    │  (helpers.ts:113-124)                               │       │
  │    │                                                     │       │
  │    │  1. Tokenize both strings:                          │       │
  │    │     · Split camelCase: "moveSnake" → "move snake"   │       │
  │    │     · Lowercase                                     │       │
  │    │     · Strip punctuation                             │       │
  │    │     · Remove stop words (auto, task, file, ...)     │       │
  │    │     · Filter words ≤ 2 chars                        │       │
  │    │                                                     │       │
  │    │  2. Compute overlap coefficient:                    │       │
  │    │                                                     │       │
  │    │            |A ∩ B|                                   │       │
  │    │    score = ─────────                                │       │
  │    │            min(|A|, |B|)                             │       │
  │    │                                                     │       │
  │    │  Why overlap (not Jaccard)?                          │       │
  │    │    Short query "snake game board" vs long memory     │       │
  │    │    content → Jaccard unfairly penalizes.             │       │
  │    │    Overlap coefficient handles asymmetric lengths.   │       │
  │    │                                                     │       │
  │    │  Why camelCase splitting (not in dedup)?             │       │
  │    │    "drawBoard" in code should match "board" in       │       │
  │    │    memory. But camelCase inflates dedup scores       │       │
  │    │    between unrelated projects sharing patterns.      │       │
  │    └─────────────────────────────────────────────────────┘       │
  │                                                                  │
  │  Filter: score ≥ 0.15                                            │
  │  Sort:   descending by score                                     │
  │  Take:   top 2 matches                                           │
  └──────────────────────────────────────────────────────────────────┘
        │
        ▼
  ┌──────────────┐
  │ matches > 0? │
  └──┬───────┬───┘
     │ YES   │ NO
     │       │
     │       ▼
     │  (nothing happens — try again on next code file
     │   edit, up to MAX_GUIDE_MATCH_ATTEMPTS = 3)
     │
     ▼
  ┌──────────────────────────────────────────────────────────────────┐
  │  INJECT: Append guide block to tool output                       │
  │                                                                  │
  │  guidesInjected = true  ◀── prevents future injections           │
  │                                                                  │
  │  output.output += """                                            │
  │                                                                  │
  │  ---                                                             │
  │  📚 **Relevant project guides from memory:**                     │
  │                                                                  │
  │  ### Snake: array-based movement with unshift/pop                │
  │  Snake is an array of {x,y} coordinates. Movement works by      │
  │  unshifting a new head position and popping the tail. Growth     │
  │  is achieved by skipping the pop. Board is drawn on canvas       │
  │  using requestAnimationFrame with delta time...                  │
  │                                                                  │
  │  ### Gotcha: food can spawn on snake body                        │
  │  When generating new food position, must check against all       │
  │  snake body segments. Use a Set of "x,y" strings for O(1)       │
  │  lookup instead of array.some()...                               │
  │                                                                  │
  │  ---                                                             │
  │  """                                                              │
  │                                                                  │
  │  The AI now sees these guides in the tool result and can          │
  │  use them to inform its next actions.                             │
  └──────────────────────────────────────────────────────────────────┘



 ┌──────────────────────────────────────────────────────────────────────────────┐
 │  BONUS: SESSION COMPACTION INJECTION                                        │
 │  (hooks.ts:214-247 — experimental.session.compacting)                       │
 └──────────────────────────────────────────────────────────────────────────────┘

  When the LLM context window fills up and OpenCode compacts the session:

  ┌──────────────────────────────────────────────────────────────────┐
  │  Build a markdown context block and inject into output.context[] │
  │                                                                  │
  │  ## Code Buddy Context (Auto-Injected)                          │
  │                                                                  │
  │  ### Project Guides & Memories                                  │
  │  ┌─────────────────────────────────────┐                        │
  │  │ Last 5 memories (sorted by time)    │                        │
  │  │ Each: [type] Title                  │                        │
  │  │       Content (max 500 chars)       │                        │
  │  └─────────────────────────────────────┘                        │
  │                                                                  │
  │  ### Known Issues (Avoid Repeating)                             │
  │  ┌─────────────────────────────────────┐                        │
  │  │ Last 3 mistakes                     │                        │
  │  │ Each: ⚠️ action → Solution: ...     │                        │
  │  └─────────────────────────────────────┘                        │
  │                                                                  │
  │  ### Key Entities                                               │
  │  ┌─────────────────────────────────────┐                        │
  │  │ First 5 entities                    │                        │
  │  │ Each: - name (type)                 │                        │
  │  └─────────────────────────────────────┘                        │
  │                                                                  │
  │  Use `buddy_remember(query)` to search for more details.        │
  └──────────────────────────────────────────────────────────────────┘
```


## End-to-End Example

```
╔══════════════════════════════════════════════════════════════════════════════════╗
║                  EXAMPLE: BUILDING A SNAKE GAME                               ║
╚══════════════════════════════════════════════════════════════════════════════════╝


  User: "Build a snake game"
       │
       │  1. AI writes SPEC.md
       │     tool.execute.after → observe(Write, SPEC.md)
       │     Not a code file → no guide injection
       │
       │  2. AI writes index.html
       │     tool.execute.after → observe(Write, index.html)
       │     Code file! Attempt #1:
       │       extractSpecContent → "Build a snake game with arrow keys..."
       │       extractDomainKeywords → ["snake", "game", "board", "score"]
       │       Search memories → "snake" matches memory from last session!
       │       Score 0.42 ≥ 0.15 → INJECT guide into output
       │       guidesInjected = true
       │
       │  3. AI writes game.js
       │     tool.execute.after → observe(Write, game.js)
       │     guidesInjected already true → no injection
       │
       │  4. AI runs: node game.js
       │     tool.execute.after → observe(Bash, "node game.js")
       │     Output has "TypeError" → hasError = true
       │
       │  5. AI edits game.js (fixes bug)
       │     tool.execute.after → observe(Edit, game.js)
       │
       │  6. Session goes idle (5 observations buffered)
       │     │
       │     ▼
       │  handleSessionIdle():
       │     buffer ≥ 3? YES
       │     has writes? YES
       │     fullAuto? YES
       │     │
       │     ▼
       │  processFullAutoObserver():
       │     LLM receives all 5 observations
       │     Returns:
       │       Entry 1: { category: "task",
       │                  title: "Snake: canvas-based game with grid movement",
       │                  summary: "Snake stored as array of {x,y}...",
       │                  type: "feature" }
       │       Entry 2: { category: "error",
       │                  title: "Gotcha: requestAnimationFrame timing",
       │                  summary: "Must use delta time...",
       │                  type: "bugfix",
       │                  errorInfo: { pattern, solution, prevention } }
       │     │
       │     ▼
       │  addMemoryWithDedup(entry1) → Jaccard 0.72 with old memory → MERGE
       │  addMemoryWithDedup(entry2) → no match → SAVE NEW
       │  mistakes.push(entry2.errorInfo)
       │     │
       │     ▼
       │  memory.json updated (1 merged, 1 new)
       │  mistakes.json updated (1 new error pattern)
       │
       ▼
  Session complete. Next time user says "Build a snake game":
    → Guide injection will surface these memories automatically.
```
