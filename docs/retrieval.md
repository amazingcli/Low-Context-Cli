# Retrieval

Retrieval is the centre of Low Context. It decides what the model gets to see, and
its output is the single largest determinant of answer quality.

The policy is explicit (§13):

> **small + relevant + verified** beats **large + possibly relevant + unverified**

---

## Pipeline

```
query
  │
  ├─ 1. understandQuery        intent, terms, identifiers, paths, module hints
  │
  ├─ 2. candidate generation   (stages, in order, adaptive)
  │       ├ project index      files and paths, BM25 over indexed metadata
  │       ├ symbols            exact symbol names, heavily weighted
  │       ├ memory             typed, scoped, confidence- and recency-aware
  │       ├ conversation       historical messages
  │       ├ dependencies       files that the top hits import or are imported by
  │       ├ git                changed files on the current branch
  │       └ recent context     what is already in the window
  │
  ├─ 3. ranking                weighted, normalised, explainable
  ├─ 4. dedupe                 one representative per file; greedy MMR
  ├─ 5. adaptive stop          enough verified evidence → stop retrieving
  ├─ 6. verification           read the actual files from disk
  └─ 7. selection              fit the context budget
```

## Intent, not keywords

`understandQuery` classifies the request and extracts structured hints before any
search runs:

```ts
{ kind: 'question' | 'code_change' | 'analysis' | 'memory_query' | 'command' | 'chat',
  terms: [...], symbols: [...], paths: [...], modules: [...],
  whole_project: boolean, historical: boolean, confidence: number }
```

So this:

```
"Why is the payment system slow?"
```

retrieves the payments module, its database access, its network calls, its caching,
recent payment changes and previous performance decisions — not documents containing
the literal phrase "payment slow" (§61).

`whole_project` requests (`analyze the whole app`) switch to progressive scanning
instead of deep retrieval — see [indexing.md](indexing.md).

## Ranking

```
score = lexical·w + semantic·w + recency·w + importance·w + confidence·w
      + exact·w + task·w − staleness·w
```

Every input is normalised to `0..1` first, so a weight change is predictable. The
redundancy penalty is applied during selection, because redundancy is a property of
the chosen set, not of a single candidate.

| Signal | Meaning |
| --- | --- |
| `lexical` | BM25 score, saturating-normalised |
| `semantic` | Cosine similarity, when embeddings are enabled |
| `recency` | Exponential decay (30-day half-life by default) |
| `importance` | Memory importance; file changes weigh in through recency |
| `confidence` | Record confidence |
| `exact` | The query contains this symbol, path or file name verbatim |
| `task` | Belongs to the active session/task/module |
| `staleness` | Index entry disagrees with the file on disk |

Signals beyond text are what make this work: dependency edges, git-changed files,
session scope and the task in flight all move candidates up or down.

## Adaptive stopping

Retrieval does not load information because it exists (§63). Each stage is
timestamped, and once `retrieval.sufficient_verified` verified, high-scoring
candidates are in hand, later stages are skipped:

```
stages: [ "project index:13/13", "memory:4/4", "verify:5/5" ]   stopped early
```

`stoppedEarly` is reported in the trace. Raising `sufficient_verified` retrieves
more; lowering it retrieves less.

## Verification

A candidate from the index is **metadata**. It becomes `verified` only when the
file has been read from disk in this request:

```
index candidate  ──►  read the file  ──►  verified candidate  ──►  context
```

The distinction is preserved all the way to the UI, because "the index says this
file probably handles receipts" is not the same claim as "this file parses and
validates receipts" (§51).

```
verification_state: indexed | inferred | verified | stale | unknown
```

When the source disagrees with the index, **the source wins**, and the index is
updated from what was found.

## Traces

`--debug` (or `ui.response_mode = debug`) prints what was retrieved and why:

```
Query: payment receipt bug

Retrieved:
 1. payments/receipt.ts              0.94  symbol + lexical match, verified
 2. payments/receipt_test.ts         0.89  related tests
 3. mem_1823                         0.76  previous payment decision
 4. payments/amounts.ts              0.61  dependency of (1)
```

In interactive mode the same information is available through the context
inspector and per-stage timings. The trace is how you debug the memory
architecture itself — a low score usually means a missing signal, not a bad query.

## Inspecting the result

```bash
lc context show          # sections, sizes, and what was dropped and why
lc context show --debug  # plus the retrieval trace and per-candidate components
lc search "receipt"      # the index view on its own
lc map file payments/receipt.ts
```

## Tuning

| Want | Change |
| --- | --- |
| Fewer, more precise results | `retrieval.top_k` down, `sufficient_verified` down |
| More context for a hard task | `--strategy deep`, `top_k` up |
| Symbol lookups to dominate | Raise `weights.exact` |
| Prefer recent changes | Raise `weights.recency` |
| Ignore stale index entries | Raise `weights.staleness` |
| Retrieve from memory more | Raise `weights.importance` / `confidence` |
| Smaller context per file | `context.max_retrieved_file_bytes` down |

```bash
lc config set retrieval.weights.exact 0.25
lc config set retrieval.top_k 16
```

## Failure behaviour

Retrieval degrades rather than fails:

| Failure | Behaviour |
| --- | --- |
| Memory search fails | Code-only retrieval; the trace notes the degradation |
| No embeddings | Keyword/hybrid retrieval — a supported mode, not an error |
| Index missing | Built on demand, or retrieval falls back to a filesystem search |
| Stale index | Detected by hash; source wins and the index is refreshed |
| Verification read fails | Candidate stays unverified and is marked as such |
