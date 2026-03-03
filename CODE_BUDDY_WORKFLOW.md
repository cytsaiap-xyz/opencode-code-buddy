# Code Buddy Plugin — ASCII Workflow

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



  ┌─────────────────────────────────────────────────────────────────────┐
  │                     2. RUNTIME — 4 PATHS                           │
  └─────────────────────────────────────────────────────────────────────┘


  ═══════════════════════════════════════════════════════════════════════
   PATH A: Manual Tool Invocation  (user runs /buddy-do, /buddy-add-memory, etc.)
  ═══════════════════════════════════════════════════════════════════════

     User: "/buddy-do Fix login bug"
           │
           ▼
   ┌───────────────────┐
   │ buddy_do(task)    │
   │ ├─ Detect type    │──▶  "bugfix" | "feature" | "refactor" | ...
   │ ├─ Est. complexity│──▶  "low" | "medium" | "high"
   │ └─ Create memory  │
   └────────┬──────────┘
            │
            ▼
   ┌───────────────────────────────────────────┐
   │         addMemoryWithDedup()              │
   │                                           │
   │   ┌──────────────┐   NO    ┌───────────┐ │
   │   │ Jaccard ≥35% │───────▶ │ Save NEW  │ │
   │   │ word overlap? │        │ memory    │ │
   │   └──────┬───────┘        └───────────┘ │
   │          │ YES                           │
   │          ▼                               │
   │   ┌──────────────┐   NO    ┌───────────┐ │
   │   │ LLM semantic │───────▶ │ Save NEW  │ │
   │   │ sim ≥ 60% ?  │        │ memory    │ │
   │   └──────┬───────┘        └───────────┘ │
   │          │ YES                           │
   │          ▼                               │
   │   ┌──────────────┐                       │
   │   │ MERGE with   │                       │
   │   │ existing     │                       │
   │   └──────────────┘                       │
   └───────────────────────────────────────────┘
            │
            ▼
   ┌───────────────────┐
   │ Persist to        │
   │ memory.json       │
   └───────────────────┘


  ═══════════════════════════════════════════════════════════════════════
   PATH B: Auto-Observer  (passive — watches every tool execution)
  ═══════════════════════════════════════════════════════════════════════

   User performs ANY coding action (edit file, run bash, etc.)
           │
           ▼
   ┌──────────────────────────────────────────────────────────┐
   │  tool.execute.after  HOOK fires                         │
   │                                                         │
   │  ┌──────────────┐  YES                                  │
   │  │ Is ignored   │──────▶ SKIP (buddy_* tools, etc.)     │
   │  │ tool?        │                                       │
   │  └──────┬───────┘                                       │
   │         │ NO                                            │
   │         ▼                                               │
   │  ┌──────────────┐     ┌─────────────────┐               │
   │  │ Detect write │     │ Detect errors   │               │
   │  │ action?      │     │ in output?      │               │
   │  └──────┬───────┘     └────────┬────────┘               │
   │         │                      │                        │
   │         ▼                      ▼                        │
   │  ┌─────────────────────────────────────┐                │
   │  │ Push to Observation Buffer          │                │
   │  │ { tool, args, result, hasError,     │                │
   │  │   fileEdited, isWriteAction, ts }   │                │
   │  └─────────────────────────────────────┘                │
   │         │                                               │
   │         ▼                                               │
   │  ┌──────────────┐  YES  ┌────────────────────────┐      │
   │  │ Is code file │──────▶│ Search memories for    │      │
   │  │ edited?      │       │ relevant guides        │      │
   │  └──────────────┘       │ (overlap coeff ≥ 0.15) │      │
   │                         └──────────┬─────────────┘      │
   │                                    │                    │
   │                                    ▼                    │
   │                         ┌────────────────────────┐      │
   │                         │ INJECT guide block     │      │
   │                         │ into tool output       │      │
   │                         └────────────────────────┘      │
   └──────────────────────────────────────────────────────────┘
           │
           │  session.idle / min actions reached / session.deleted
           ▼
   ┌──────────────────────────────────────────────────────────┐
   │              FLUSH OBSERVATIONS                         │
   │                                                         │
   │  ┌──────────────────┐     ┌──────────────────────┐      │
   │  │ Buffer ≥ 3       │ NO  │                      │      │
   │  │ observations?    │────▶│  SKIP (not enough)   │      │
   │  └──────┬───────────┘     └──────────────────────┘      │
   │         │ YES                                           │
   │         ▼                                               │
   │  ┌──────────────┐                                       │
   │  │ fullAuto     │                                       │
   │  │ = true ?     │                                       │
   │  └──┬───────┬───┘                                       │
   │  YES│       │NO                                         │
   │     ▼       ▼                                           │
   │  ┌────────┐ ┌──────────────┐                            │
   │  │ LLM    │ │ Rule-based   │                            │
   │  │classify│ │ classify     │                            │
   │  │multi-  │ │ single       │                            │
   │  │entry   │ │ summary      │                            │
   │  └───┬────┘ └──────┬───────┘                            │
   │      │             │                                    │
   │      └──────┬──────┘                                    │
   │             ▼                                           │
   │      ┌──────────────┐                                   │
   │      │ Dedup & Save │                                   │
   │      │ to memory    │                                   │
   │      └──────────────┘                                   │
   │             │                                           │
   │             ▼                                           │
   │      ┌──────────────┐                                   │
   │      │ Clear buffer │                                   │
   │      └──────────────┘                                   │
   └──────────────────────────────────────────────────────────┘


  ═══════════════════════════════════════════════════════════════════════
   PATH C: Session Compaction  (context injection for LLM awareness)
  ═══════════════════════════════════════════════════════════════════════

   Session context being compacted (LLM window filling up)
           │
           ▼
   ┌──────────────────────────────────────────┐
   │  session.compacting HOOK                 │
   │                                          │
   │  Gather:                                 │
   │    · Last 5 memories                     │
   │    · Last 3 mistakes                     │
   │    · First 5 entities                    │
   │                                          │
   │         ▼                                │
   │  ┌──────────────────────────────┐        │
   │  │ Build markdown context block │        │
   │  │ & append to output.context[] │        │
   │  └──────────────────────────────┘        │
   └──────────────────────────────────────────┘


  ═══════════════════════════════════════════════════════════════════════
   PATH D: Process Exit Safety Net  (sync flush before shutdown)
  ═══════════════════════════════════════════════════════════════════════

   Node.js process exiting
           │
           ▼
   ┌──────────────────────────────────────────┐
   │  process.beforeExit / process.exit       │
   │                                          │
   │  ┌──────────────┐  NO                    │
   │  │ Buffer ≥ 3?  │─────▶  EXIT           │
   │  └──────┬───────┘                        │
   │         │ YES                            │
   │         ▼                                │
   │  ┌──────────────────────────────────┐    │
   │  │ flushObservationsSync()          │    │
   │  │ · Rule-based classify (no LLM)  │    │
   │  │ · Jaccard dedup (≥55% merge)    │    │
   │  │ · Save to memory.json           │    │
   │  └──────────────────────────────────┘    │
   └──────────────────────────────────────────┘



  ┌─────────────────────────────────────────────────────────────────────┐
  │                     3. DATA PERSISTENCE                            │
  └─────────────────────────────────────────────────────────────────────┘

   All paths ultimately write to:

   ~/.config/opencode/code-buddy/data/
       │
       ├── memory.json ──────── memories[], decisions, bugfixes, lessons
       ├── entities.json ────── knowledge graph nodes
       ├── relations.json ───── knowledge graph edges
       └── mistakes.json ────── error patterns & prevention



  ┌─────────────────────────────────────────────────────────────────────┐
  │                     4. TOOL OVERVIEW (21 total)                    │
  └─────────────────────────────────────────────────────────────────────┘

   ┌─────────────┐ ┌─────────────┐ ┌─────────────┐ ┌─────────────────┐
   │   CORE (3)  │ │  TASK (3)   │ │ MEMORY (5)  │ │ KNOWLEDGE       │
   │             │ │             │ │             │ │ GRAPH (3)       │
   │ buddy_help  │ │ buddy_do    │ │ _remember   │ │ _create_entity  │
   │ buddy_config│ │ buddy_done  │ │ _recent     │ │ _search_entities│
   │ buddy_llm_  │ │ (auto-obs)  │ │ _by_category│ │ _create_relation│
   │   test      │ │             │ │ _stats      │ │                 │
   │             │ │             │ │ _add_memory │ │                 │
   └─────────────┘ └─────────────┘ └─────────────┘ └─────────────────┘

   ┌─────────────┐ ┌─────────────┐ ┌─────────────────────────────────┐
   │ ERROR       │ │ WORKFLOW &  │ │ AI INTEGRATION (3)              │
   │ LEARN (2)   │ │ SESSION (2) │ │                                 │
   │             │ │             │ │ buddy_ask_ai                    │
   │ _record_    │ │ _get_work-  │ │ buddy_analyze_code              │
   │  mistake    │ │  flow_guide │ │ buddy_suggest_improvements      │
   │ _get_mistake│ │ _get_session│ │                                 │
   │  _patterns  │ │  _health    │ │                                 │
   └─────────────┘ └─────────────┘ └─────────────────────────────────┘



  ┌─────────────────────────────────────────────────────────────────────┐
  │                     5. DEDUPLICATION STRATEGY                      │
  └─────────────────────────────────────────────────────────────────────┘

                    New Memory Entry
                         │
                         ▼
              ┌─────────────────────┐
              │  ASYNC DEDUP        │  (during normal operation)
              │                     │
              │  Stage 1: Jaccard   │
              │  word overlap ≥ 35% │
              │       │             │
              │    YES│    NO───────│──▶ Save as NEW
              │       ▼             │
              │  Stage 2: LLM      │
              │  semantic ≥ 60%     │
              │       │             │
              │    YES│    NO───────│──▶ Save as NEW
              │       ▼             │
              │  MERGE entries      │
              └─────────────────────┘

              ┌─────────────────────┐
              │  SYNC DEDUP         │  (on process exit — no LLM)
              │                     │
              │  Jaccard ≥ 55%      │
              │       │             │
              │    YES│    NO───────│──▶ Save as NEW
              │       ▼             │
              │  MERGE in-place     │
              └─────────────────────┘

   Merge behavior:
     · Keep newer title & content
     · Union tags from both entries
     · Update timestamp
```
