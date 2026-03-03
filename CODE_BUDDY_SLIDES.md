# Code Buddy — Slide Diagrams

## Slide 1: How Auto-Observer Works

```
╔═══════════════════════════════════════════════════════════════╗
║                    AUTO-OBSERVER                              ║
╚═══════════════════════════════════════════════════════════════╝

  User codes normally (edit, bash, write, etc.)
       │
       │  Every tool execution
       ▼
  ┌─────────┐    ┌──────────┐    ┌──────────────────────┐
  │ Filter  │───▶│ Classify │───▶│ Buffer Observation   │
  │         │    │          │    │                      │
  │ Skip    │    │ Write?   │    │ { tool, file, args,  │
  │ buddy_* │    │ Error?   │    │   result, hasError,  │
  │ tools   │    │ File?    │    │   isWriteAction }    │
  └─────────┘    └──────────┘    └──────────┬───────────┘
                                            │
                                    buffer fills up...
                                            │
       ┌────────────────────────────────────┘
       │  session.idle / session.deleted / process.exit
       ▼
  ┌──────────────────────┐
  │  Buffer ≥ 3 actions? │──NO──▶ skip
  │  Has writes/errors?  │
  └──────────┬───────────┘
             │ YES
             ▼
  ┌─────────────────────────────────────────────────┐
  │              CLASSIFY & SAVE                     │
  │                                                  │
  │  ┌─────────────┐         ┌───────────────────┐  │
  │  │  Full Auto  │         │  Single Summary   │  │
  │  │  (LLM)     │   OR    │  (Rule-based)     │  │
  │  │             │         │                   │  │
  │  │  1-3 smart  │         │  1 entry from     │  │
  │  │  entries    │         │  pattern matching │  │
  │  └──────┬──────┘         └────────┬──────────┘  │
  │         └──────────┬──────────────┘              │
  │                    ▼                             │
  │             ┌─────────────┐                      │
  │             │   Dedup &   │                      │
  │             │   Save to   │──▶ memory.json       │
  │             │   memory    │──▶ mistakes.json     │
  │             └─────────────┘                      │
  └─────────────────────────────────────────────────┘
```


## Slide 2: How Guide Injection Works

```
╔═══════════════════════════════════════════════════════════════╗
║                   GUIDE INJECTION                             ║
╚═══════════════════════════════════════════════════════════════╝

  AI edits a code file (.ts, .js, .py, .html, ...)
       │
       ▼
  ┌─────────────────────┐
  │  5 Gates (all must  │
  │  pass):             │
  │                     │
  │  ✓ First time?      │
  │  ✓ File edited?     │
  │  ✓ Is code file?    │
  │  ✓ Memories exist?  │
  │  ✓ Attempts < 3?    │
  └──────────┬──────────┘
             │ ALL PASS
             ▼
  ┌──────────────────────────────────────────┐
  │  Build Search Context (best → worst)     │
  │                                          │
  │  1. SPEC.md text     "Build a snake..."  │
  │  2. Domain keywords  [snake, board, food]│
  │  3. HTML <title>     "Snake Game"        │
  │  4. Function names   moveSnake, draw...  │
  └──────────────────┬───────────────────────┘
                     │
                     ▼
  ┌──────────────────────────────────────────┐
  │  Score Each Memory                       │
  │                                          │
  │            |query ∩ memory|              │
  │  score  =  ────────────────              │
  │            min(|query|, |memory|)        │
  │                                          │
  │  (overlap coefficient — handles short    │
  │   query vs long memory content)          │
  │                                          │
  │  Filter:  score ≥ 0.15                   │
  │  Pick:    top 2 matches                  │
  └──────────────────┬───────────────────────┘
                     │
                     ▼
  ┌──────────────────────────────────────────┐
  │  Inject into Tool Output                 │
  │                                          │
  │  ┌────────────────────────────────────┐  │
  │  │ 📚 Relevant project guides:        │  │
  │  │                                    │  │
  │  │ ### Snake: array-based movement    │  │
  │  │ Snake is an array of {x,y}. Move = │  │
  │  │ unshift new head, pop tail...      │  │
  │  │                                    │  │
  │  │ ### Gotcha: food on snake body     │  │
  │  │ Check all segments when spawning   │  │
  │  │ new food. Use Set for O(1) lookup. │  │
  │  └────────────────────────────────────┘  │
  │                                          │
  │  AI sees this → makes better decisions   │
  └──────────────────────────────────────────┘
```


## Slide 3: The Full Loop

```
╔═══════════════════════════════════════════════════════════════╗
║              THE LEARNING LOOP                                ║
╚═══════════════════════════════════════════════════════════════╝


              ┌──────────────────┐
              │    User Codes    │
              │  (edit, bash...) │
              └────────┬─────────┘
                       │
            ┌──────────┴──────────┐
            ▼                     ▼
   ┌─────────────────┐   ┌────────────────┐
   │  AUTO-OBSERVE   │   │ GUIDE INJECT   │
   │                 │   │                │
   │  Watch actions  │   │ Search memory  │
   │  Buffer them    │   │ for relevant   │
   │  Detect errors  │   │ past knowledge │
   └────────┬────────┘   └───────┬────────┘
            │                    │
            ▼                    │
   ┌─────────────────┐          │
   │  CLASSIFY       │          │
   │                 │          │
   │  LLM extracts   │          │
   │  knowledge:     │          │
   │  · mental model │          │
   │  · decisions    │          │
   │  · gotchas      │          │
   │  · conventions  │          │
   └────────┬────────┘          │
            │                   │
            ▼                   │
   ┌─────────────────┐         │
   │  DEDUP & SAVE   │         │
   │                 │         │
   │  Jaccard + LLM  │         │
   │  similarity     │         │
   │  merge or new   │         │
   └────────┬────────┘         │
            │                  │
            ▼                  │
   ┌─────────────────┐        │
   │   memory.json   │────────┘
   │   mistakes.json │  feeds back into
   └─────────────────┘  guide injection
                        next session
```


## Slide 4: Dedup at a Glance

```
╔═══════════════════════════════════════════════════════════════╗
║                  DEDUPLICATION                                 ║
╚═══════════════════════════════════════════════════════════════╝

  New memory arrives
       │
       ▼
  ┌────────────────┐         ┌────────────────┐
  │ Jaccard ≥ 0.65 │──YES──▶ │                │
  │ (word overlap)  │         │     MERGE      │
  └───────┬────────┘         │                │
          │ NO               │  · Keep newer  │
          ▼                  │    content     │
  ┌────────────────┐         │  · Union tags  │
  │ LLM sim ≥ 0.75│──YES──▶ │  · Update ts   │
  │ (semantic)      │         │                │
  └───────┬────────┘         └────────────────┘
          │ NO
          ▼
  ┌────────────────┐
  │   SAVE AS NEW  │
  └────────────────┘


  On process exit (no LLM available):

  ┌────────────────┐
  │ Jaccard ≥ 0.55 │──YES──▶ MERGE
  │ (higher bar,    │
  │  no AI confirm) │──NO───▶ SAVE NEW
  └────────────────┘
```
