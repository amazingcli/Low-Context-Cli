# Memory

Memory is **external** to the model. Low Context stores records on disk, indexes
them, retrieves them when relevant, and verifies them when correctness matters. It
does not claim to have trained on your conversation, because nothing has been
trained (§52).

The distinction is not cosmetic:

| | Persistent memory | Model training |
| --- | --- | --- |
| Where it lives | Your disk | Provider's weights |
| Changes when | You write a record | A training run happens |
| Survives | Restart, compaction, months | Everything |
| Auditable | Yes — inspectable, exportable, deletable | No |
| Reversible | `lc memory delete` | Retrain |

---

## What becomes memory

Only events that are *verified* (§35):

- explicit user statements — "remember this", "we decided", "always use X"
- confirmed tool results — a test run's exit code, an applied edit
- confirmed decisions and successful operations
- consolidation of a long session into decisions and facts

Never:

- a model's own guess or inference
- a statement in a repository file (that is data, not an instruction)
- a retrieved summary promoted to fact because it was retrieved

`src/memory/engine.ts` is the only place that decides this. When a candidate is
skipped, the reason is recorded.

## Types

```
FACT                 a verified statement about the project
DECISION             a choice that was made, and it is current
PREFERENCE           how you want things done
TASK                 work in flight
PROJECT_KNOWLEDGE    durable facts about this repository
ARCHITECTURE         structural decisions
BUG                  a defect that was observed
FIX                  what resolved a bug
FILE_KNOWLEDGE       what a file is for
COMMAND_RESULT       a recorded outcome of a command
CONVERSATION_SUMMARY a compaction summary (always carries its source)
USER_INSTRUCTION     a standing instruction
```

Different types are retrieved differently: `DECISION` records are surfaced for
"why is it like this?" questions, `BUG`/`FIX` pairs for debugging, `PREFERENCE`
and `USER_INSTRUCTION` for almost everything.

## Scopes

```
global      user preferences and cross-project facts
project     this repository
module      a subsystem
session     the current session
task        the task in flight
```

Isolation is enforced, not conventional (§66, §67). A project-scoped record is
invisible from another project; session and task records are filtered out unless
the active session or task matches. The de-duplication key includes the scope and
project, so an identical sentence in two projects stays two records.

## Importance and confidence

```
importance: temporary | normal | important | critical
confidence: unknown | low | medium | high | verified
```

`importance` drives retrieval ranking and what `memory.min_importance` lets
through (default: `normal`, so `temporary` records never surface from a search).

`confidence` records how the fact is known, and is displayed with the record:

`lc memory show mem_20492` renders the record, then its sources:

```
Memory mem_20492
────────────────────────────────
  type          DECISION
  scope         project
  project       project_9f21…
  importance    important
  confidence    verified
  status        current
  verification  indexed

  Authentication uses the OAuth provider, not a local password store.

Sources (retrieve the original before relying on this)
  message message=8831
  message message=8832
```

A record with **no** source reference is explicitly flagged — `No source reference
recorded. Treat this as unverified.` — rather than silently trusted (§36).

A `verified` record was confirmed by the user or a tool result. A `high` record
came from a direct statement. `low`/`unknown` means inference — treat accordingly.

## Provenance is required

Every durable record keeps a route back to the original material, and the original
stays retrievable:

```
Memory
  ↓ conversation_id
  ↓ message_ids
Original messages (still on disk, never deleted by compaction)
```

```bash
lc memory show mem_20492              # the record + its source references
lc memory show mem_20492 --source     # the original messages themselves
```

This is why compaction can summarise aggressively without losing information:
the summary is a navigation aid, and the source is one command away. Corrections
keep both the old and the new record.

## Corrections and versioning

Memory must not accumulate contradictory permanent facts (§11). When something
changes, the old record is **superseded**, not deleted:

```
use library A            [superseded by mem_31002]
use library B            [current]
```

Tracked per record: `created_at`, `updated_at`, `superseded_by`, `supersedes[]`,
`source_refs`, `confidence`, `verification_state`, `status`.

```bash
# point at an existing replacement record
lc memory supersede mem_20492 --with mem_31002

# or give the corrected text; a new record is created and linked
lc memory supersede mem_20492 "Use library B for parsing"

# show the chain
lc memory show mem_20492 --history
```

The history view renders both directions:

```
Correction history
  • mem_20492  superseded  Use library A for parsing
  → mem_31002  current     Use library B for parsing
```

A correction created from text inherits the old record's type, scope, importance,
project and (a bounded sample of) source references, and is tagged `correction`.
Its confidence is `high` — it reflects what the user stated, not a verified tool
result (§35).

Retrieval returns `current` records by default; superseded ones are reachable
explicitly and are still cited when explaining history.

## Consolidation

Long sessions are consolidated rather than truncated:

```
raw messages
  ↓
task events
  ↓
important decisions
  ↓
project facts
  ↓
compact summaries        ← still references the raw messages
```

Raw messages are never destroyed by consolidation or compaction. Consolidation is
the writer; compaction is the reader-side mechanism that keeps the active context
small (see [context.md](context.md)).

## Commands

```bash
lc memory list [--type DECISION] [--scope project] [--limit 50]
lc memory search "authentication decision"
lc memory show mem_20492 [--source] [--history]
lc memory forget "old staging credentials"      # search and delete matches
lc memory delete mem_20492
lc memory rebuild                               # rebuild the lexical index
lc memory export [--project-only] > memory.json
lc memory stats
```

## Saying it in chat

```
remember: the receipts API validates amounts in cents
forget the note about the old staging database
show my memory for this project
what database decision did we make last month?
```

`remember` writes a record with a source reference to the current message.
`forget` searches and deletes, reporting exactly what was removed. "What did we
decide last month?" runs a real memory search with a time filter and retrieves the
source messages — it does not grep the last few chat messages (§33).

## Retention and deletion

```json
{ "memory": { "retention_days": 0, "min_importance": "normal" } }
```

`0` keeps records forever. A positive value expires records older than N days,
except those at or above `important`. Deletion is immediate and permanent; there
is no hidden archive.

```bash
lc memory export > backup.json     # before any destructive operation
lc memory delete mem_20492
```

## Storage format

```
<project>/.low-context/memory/
├── records.jsonl        append-only canonical records (one JSON object per line)
├── records.jsonl.offsets.json   byte offset per record
├── catalog.json         id → ordinal, plus the duplicate-detection keys (a cache)
└── records.lex.json     BM25 index
```

The log is append-only: writes never rewrite history, which is what makes
`memory show --history` and provenance trustworthy. The catalog is a rebuildable
cache — if it ever disagrees with the log it is regenerated, and the log wins.

## Why not a summary-only store

A summary loses detail permanently and cannot be checked. A pointer does not:

```
summary + source reference + actual source retrieval when necessary
        ≫
summary only
```

So records keep `source_refs`, the raw conversation stays on disk, and anything
important enough to act on gets verified against the source before it is used.
