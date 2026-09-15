# Architecture

Low Context is a layered application. Each layer has one job, and the layers
above it know nothing about how the ones below are implemented.

```
┌──────────────────────────────────────────────────────────────┐
│                            CLI                               │
│      args · terminal UI · commands · wizard · permissions     │
└───────────────────────────┬──────────────────────────────────┘
                            │
┌───────────────────────────▼──────────────────────────────────┐
│                       Agent loop                             │
│   understand → retrieve → verify → plan → act → observe →    │
│                    verify → update → respond                 │
└───┬──────────┬───────────┬───────────┬───────────┬───────────┘
    │          │           │           │           │
┌───▼───┐ ┌────▼────┐ ┌────▼─────┐ ┌───▼────┐ ┌────▼─────┐
│Retrie-│ │ Context │ │  Tools   │ │ Memory │ │Providers │
│ val   │ │ manager │ │ system   │ │ engine │ │          │
└───┬───┘ └────┬────┘ └────┬─────┘ └───┬────┘ └────┬─────┘
    │          │           │           │           │
┌───▼──────────▼───────────▼───────────▼───────────▼─────────┐
│                        Storage                               │
│  JsonlLog · MemoryStore · ConversationStore · IndexStore ·   │
│  SessionStore · TaskStore · ProjectStore · VectorStore       │
└───────────────────────────┬──────────────────────────────────┘
                            │
┌───────────────────────────▼──────────────────────────────────┐
│                 Local filesystem (default)                   │
│      <project>/.low-context        $LOW_CONTEXT_HOME         │
└──────────────────────────────────────────────────────────────┘
```

---

## The eight layers

### 1. Core (`src/core/`)

Stable internal objects (§83) and the primitives everything else shares.

| File | Responsibility |
| --- | --- |
| `types.ts` | `MemoryRecord`, `IndexedFile`, `RetrievalCandidate`, `ContextItem`, `ToolCall`, `SourceReference`, ranking weights, etc. |
| `ids.ts` | Prefixed, time-sortable ids (`mem_…`, `msg_…`, `file_…`) |
| `errors.ts` | `LowContextError` with a stable `code` and an optional `fix` hint |
| `util.ts` | Hashing, atomic writes, byte formatting, debounce, `jaccard`, clamping |
| `paths.ts` | Global and per-project locations, project-root discovery, `isInside` containment |
| `config.ts` | Config model, deep merge, `LOW_CONTEXT_*` overrides |
| `logger.ts` | Structured JSONL logs under `$LOW_CONTEXT_HOME/logs` |

Nothing here is user-interface or provider specific.

### 2. Storage (`src/storage/`)

All persistence. Every store is an **interface** in `interfaces.ts` with one
shipped local-first implementation.

`JsonlLog` is the foundation: an append-only JSONL file with a persisted byte-offset
sidecar (`*.offsets.json`), so a record can be read by ordinal without rescanning
the file. The sidecar is authoritative only when its recorded byte length matches
the data file exactly; anything else triggers a rebuild, because a corrupt index
must never produce silently wrong data.

Consequences that matter:

- **Never rewrite the whole file to append one record** — appends push one
  integer to the offset array.
- **Appends are serialised.** The offset array must be pushed in the same order
  the bytes land on disk, and unguarded concurrency would open one file handle
  per concurrent append.
- **The `id → ordinal` catalog is a cache.** It is persisted on a debounce and
  rebuilt from the log whenever it disagrees with the log length, so a stale file
  costs one rebuild and never correctness. Duplicate detection uses the same
  catalog for an O(1) exact-key lookup rather than a full-text scan.

Stores: `FileMemoryStore`, `FileConversationStore`, `FileIndexStore`,
`FileSessionStore`, `FileTaskStore`, `FileProjectStore`, `FileVectorStore`.

`PersistentLexicalIndex` is shared by the memory and conversation stores: both
need "which records score highest for this query?".

### 3. Search (`src/search/`)

The retrieval primitives, independent of what is being searched.

- `tokenize.ts` — code-aware tokenisation. Splits identifiers on case and
  separators (`parseRecord_412` → `parse`, `record`, `412`), keeps stopword lists
  for queries, and produces `analyzeQuery` output (terms, identifiers, path terms).
- `bm25.ts` — `InvertedIndex`: real postings lists, document lengths, BM25 scoring
  with `k1`/`b`, per-field boosts, serialisation, and incremental `upsert`.
- `rank.ts` — the explicit scoring model, greedy MMR-style dedupe, and
  budget-aware selection.

### 4. Index (`src/index/`)

The project map — a **navigation structure**, explicitly not a substitute for
source (§4C).

- `ignore.ts` — layered ignore rules (built-in never-index list, `.gitignore`
  basics, `config.index.extra_ignore`).
- `analysis.ts` — per-file analysis: language, imports, exports, symbols, routes,
  dependencies, hashes. Tree-sitter/AST-style extraction where the language is
  supported, carefully bounded heuristics elsewhere.
- `scanner.ts` — the filesystem walk with size/symlink/binary guards.
- `project-map.ts` — the hierarchical view (project → module → directory → file →
  symbol) rendered for the model, at whatever depth the task needs.
- `index-store.ts` / `indexer.ts` — persistence, incremental refresh, stale
  detection by content hash.

### 5. Memory (`src/memory/`)

The **only** place that decides what becomes durable memory. It is deliberately
conservative: memory is written from verified events — explicit user statements,
confirmed tool results, confirmed decisions — never from model guesses.

`candidatesFromUserMessage` detects signals such as "remember this", "we decided",
"always use". `candidateFromExplicitRemember` handles explicit remember requests.
Consolidation turns long sessions into decisions and project facts while leaving
the raw messages untouched.

### 6. Retrieval (`src/retrieval/`)

The pipeline that turns a request into a small, ranked, verified candidate set.

```
understandQuery
   ↓
plan stages (adaptive)
   ↓
generate candidates
   ├── project index (files, paths, symbols)
   ├── symbol index (exact names)
   ├── memory index (types, scopes, confidence, recency)
   ├── conversation history
   ├── dependency expansion
   └── git (changed files)
   ↓
rank → dedupe → adaptive stop
   ↓
verify (read the real file from disk)
   ↓
select within budget
```

`intent.ts` classifies the request (`code_change`, `question`, `analysis`,
`memory_query`, `command`, `chat`) and extracts paths, symbols and module hints —
so "why is the payment system slow?" retrieves the payment module, its database
access, its caching and recent changes, not the literal phrase.

### 7. Context (`src/context/`)

- `estimator.ts` — provider-agnostic token estimation. ASCII at ~4 chars/token,
  CJK at ~1 token/char, with a floor. Marked as an estimate everywhere it is shown;
  provider-reported usage replaces it when the API returns real numbers.
- `builder.ts` — constructs the request in labelled sections within a budget, and
  reports what was included, what was dropped, and why.
- `compactor.ts` — when the conversation crosses the threshold: extract decisions,
  outcomes and context; write memory records with source references; mark how far
  compaction reached; drop those messages from *active* context while leaving them
  on disk.

Strategies: `minimal`, `balanced`, `deep`, `maximum`.

### 8. Tools (`src/tools/`)

A uniform `ToolDefinition` interface: name, description, JSON schema, and an
`execute(ctx, args)` returning a `ToolResult`. Registered in `registry.ts` and
gated by the permission engine.

`output.ts` decides how a tool result reaches the model: small output passes
through; large output is written to an artifact and replaced by
head + extracted diagnostics + tail.

---

## The agent loop

```
UNDERSTAND   classify intent, extract paths/symbols/constraints
RETRIEVE     multi-stage candidates (retrieval engine)
VERIFY       read actual sources for anything important
PLAN         decide the action; ask if the request is ambiguous
ACT          call tools through the permission engine
OBSERVE      collect tool results (already spill-aware)
VERIFY       re-read the changed region; run tests when configured
UPDATE       refresh index entries; write memory from verified events
RESPOND      answer with the minimum useful context
```

The loop is not `prompt → model → run random tools`. Retrieval and verification
are *stages with outputs*, recorded in a trace (`--debug`, `lc context show`).

---

## Verification model

```
index ≠ source        summary ≠ source        memory ≠ source
```

Every candidate carries a `verification_state`: `indexed`, `inferred`,
`verified`, `stale` or `unknown`. A code candidate is `verified` only after the
file has been read from disk in the current request. Retrieval reads the top
candidates from disk before they are used for a change, and the index is updated
from what was found — the source always wins over the index.

This is why `lc context show` distinguishes *retrieved* from *verified*: the
difference is the whole point.

---

## Scope and isolation

Memory belongs to a scope, and retrieval respects it:

```
global   ─ user preferences, cross-project facts
project  ─ this repository's decisions and knowledge
module   ─ a subsystem's facts
session  ─ this working session
task     ─ the task in flight
```

A project-scoped record never surfaces in another project. Session and task
records are filtered out unless the active session or task matches.

---

## Source priority

When two sources disagree, the newer and more directly verified wins:

```
current verified source
  > recent verified tool result
  > current project state
  > recent memory
  > old memory
  > old summary
```

Older memories are never trusted blindly; a record can be superseded, and its
`status` records that (§11).

---

## Error recovery

Failures degrade, they do not corrupt:

| Failure | Behaviour |
| --- | --- |
| Provider timeout / HTTP error | Retry policy, then fallback model if configured |
| Malformed tool call | Reported back to the model as a tool error |
| Tool failed | Exit code, stderr and diagnostics preserved; output still spill-aware |
| File changed mid-operation | Edit is refused and the region is re-read |
| Stale index | Detected by hash, index updated, source wins |
| Memory retrieval failure | Degrades to code-only retrieval, noted in the trace |
| Corrupt session | Rebuildable from conversation history |
| Missing configuration | Setup wizard offered; never a crash |

---

## Design rules

1. **Never fake behaviour.** If a component is not finished, it is isolated
   behind an interface — not stubbed with something that pretends to work.
2. **Retrieval is deliberate.** Adding more information must be justified.
3. **Verification is cheap; wrong code changes are not.**
4. **One giant file is a bug.** Each subsystem is a directory of focused modules,
   and each module's header comment states its interface and data flow.
5. **Local-first.** No cloud dependency for indexing or memory.
6. **The user is in control.** Memory, sessions, permissions, retention and
   telemetry are all explicit.
