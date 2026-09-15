# Context management

Context is a limited working area, not a warehouse (§3). Low Context accounts for
every section of every request and can show you the accounting.

## The budget

```
usable = context_limit − reserve_output_tokens − overhead

system instructions      ~2.1k   fixed
recent conversation      ~3.4k   last N messages verbatim
task memory              ~0.8k   the task in flight
project map              ~1.2k   only the levels needed
retrieved memory         ~0.9k   ranked, deduplicated
retrieved code           ~6.2k   verified excerpts
tool results             ~1.1k   spill-aware
────────────────────────────────
reserved output          ~8.0k   never spent on input
```

Nothing is truncated silently. If a section has to shrink, the reason is reported by
`lc context show`.

## Construction

`builder.ts` assembles a request in labelled sections and returns not just the
messages but the accounting:

- **system instructions** — role, rules, untrusted-content policy. Prompt-injection
  resistant: retrieved repository content is data, never instructions.
- **task memory** — the compact current task: goal, decisions made, pending work,
  relevant files.
- **project map** — the minimum depth needed for this request.
- **retrieved memory** — ranked records with their confidence and type.
- **retrieved code** — *verified* excerpts only, byte-capped per file, deduplicated
  so the same file never arrives twice through two stages.
- **conversation** — the last `keep_recent_messages` verbatim, plus a compaction
  summary covering the rest.
- **tool results** — already spill-aware: large output became an artifact plus its
  diagnostics.

Deduplication matters more than it sounds: a memory summary that *describes* a file
and that file's actual source do not both need to be in the request — the source is
strictly better (§55).

## Strategies

| Strategy | Use it when |
| --- | --- |
| `minimal` | Small local model, narrow question |
| `balanced` | Default |
| `deep` | Cross-file change, hard debugging |
| `maximum` | Large model, genuinely broad task |

```bash
lc --strategy deep "migrate the auth middleware"
lc config set context.strategy minimal
```

Strategy changes retrieval depth and per-file caps. It never disables verification.

## Compaction

Compaction runs before the window is at risk, at
`context.compaction_threshold` (default `0.7`) of the usable window:

```
50 messages
   ↓  identify old / less-relevant messages
   ↓  extract decisions, outcomes, context   (LLM when available,
   ↓                                          deterministic extraction otherwise)
   ↓  write memory records with source_refs
   ↓  mark how far compaction reached
   ↓  remove those messages from ACTIVE context
   ↓
summary + recent messages
```

Two guarantees:

1. **The persistent history is untouched.** Compaction changes what the *builder*
   sends. The messages stay on disk and stay retrievable.
2. **Decisions survive.** Extracted decisions become `DECISION` records carrying
   references to the messages they came from, so they can be verified later.

Measured on a 2,000-message conversation: 30,994 raw tokens → a 2,938-token summary,
a 10.5x reduction, in ~19 ms, with 4 decisions preserved.

```json
{
  "context": {
    "strategy": "balanced",
    "compaction_threshold": 0.7,
    "keep_recent_messages": 12,
    "auto_compact": true,
    "reserve_output_tokens": 8192
  }
}
```

## Inspection

```bash
lc context show
```

```
Context budget
──────────────────────────────
System instructions      2.1k
Recent conversation      3.4k
Task memory              0.8k
Project map              1.2k
Retrieved memory         0.9k
Code                     6.2k
Tool results             1.1k
Reserved output          8.0k
──────────────────────────────
Total                   19.7k / 128k          balanced
```

`lc context show --debug` adds the retrieval trace for every included item and the
reason for everything that was excluded.

The interactive session shows the same information continuously, so you always know
what the model can see:

```
Model: openai/gpt-4o     Project: ~/work/api
Context: 18.2k / 128k    Memory: 2,481 records    Index: current
```

## Token estimation

Real tokenisers are provider-specific and not universally available offline, so
estimation is heuristic and always labelled:

- ASCII at roughly 4 characters per token
- CJK and other wide scripts at roughly 1 token per character
- a floor so short prompts are not wildly understated

Provider-reported usage always replaces the estimate when the API returns it, and
the UI marks which numbers are which (§79).

## Tool output

Tool output is the usual way a context window dies. Low Context handles it at the
source (§56, §58):

```
10 MB build log
   ↓  full output written to an artifact
   ↓  diagnostics extracted
   ↓  head + diagnostics + tail inline
active context: 1,383 tokens
artifact: retrievable in full on demand
```

Measured: 8.8 MB of build log becomes **1,383 inline tokens** (0.06% of the input)
while all 10 TypeScript errors survive, and the full artifact can be grepped in
~45 ms.

Strategies available for any command's output: head, tail, grep, error extraction,
structured parsing, summary, saved artifact. Full output is always available on
request.
