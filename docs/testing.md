# Testing

```bash
npm test          # build + node --test dist/tests/
npm run test:only # run without rebuilding
npm run bench     # 33 benchmark checks over the real subsystems
npm run typecheck # tsc --noEmit
```

Current status: **78 tests pass, 33 benchmark checks pass.**

## Test layout

| File | Covers |
| --- | --- |
| `tests/storage.test.ts` | `JsonlLog` (offsets, corruption recovery, concurrent appends), conversation, session and task stores, lexical index round-trip |
| `tests/memory.test.ts` | Writing, retrieve ranking, provenance, duplicate detection, corrections/supersede, scoping and isolation, retention, rebuild, export |
| `tests/index.test.ts` | Ignore rules, symbol extraction, scanning, incremental refresh, stale detection, project map rendering |
| `tests/retrieval.test.ts` | Query intent, multi-stage candidates, ranking order, dedupe, adaptive stop, verification, traces |
| `tests/context.test.ts` | Token estimation, budgets per strategy, context construction, compaction, decision preservation, output spilling |
| `tests/tools.test.ts` | Filesystem tools, structured edit, terminal execution, output limits, tool registry |
| `tests/agent.test.ts` | The full loop against the mock provider: retrieve → act → verify → update, session restore, task state |
| `tests/security.test.ts` | Secret resolution precedence, redaction, path containment, injection detection, permission decisions |

`tests/helpers.ts` provides the scaffolding: a throwaway `LOW_CONTEXT_HOME`, a
throwaway project root, and a config factory with the permissions mode and index
refresh set for testing.

Everything runs on the built output (`dist/tests/`) with `node:test` and
`node:assert/strict`. No test framework dependency, no mocking library — providers
are stubbed with `MockProvider` and a local HTTP server where needed.

## Properties worth testing

The suite is organised around the architecture's claims rather than around files:

- **Memory is external.** A record written, then read back by a *new* store
  instance, proves persistence rather than an in-process cache.
- **Provenance survives.** A record's `source_refs` resolve to the original
  messages after compaction.
- **Stale index never wins.** Change a file, and retrieval returns the new content
  while the index is corrected.
- **Isolation holds.** A project-scoped record written under project A is
  unreachable from project B, and the dedupe key cannot merge across projects.
- **Failures do not corrupt.** A malformed JSONL line is skipped, not fatal; an
  offset sidecar that disagrees with the data file is rebuilt.
- **Permissions deny by default in `safe`.** A destructive command is refused, and
  the refusal is structured.
- **Untrusted content is data.** An injection attempt in a repository file is
  detected and does not become an instruction.

## Benchmarks

`bench/run.ts` measures the promises the architecture makes, using the real
scanner, the real BM25 index and the real stores — nothing is mocked (§86).

```
npm run bench
```

It generates repositories of 50 / 500 / 2,000 / 10,000 files, seeds 50,000 memory
records, compacts a 2,000-message conversation, and spills an 8.8 MB build log,
asserting on the results as it goes.

Reference output (Node 18, this repository's machine class):

```
## Indexing
   repo        files   cold (ms)   files/s   warm (ms)   incremental (ms)
   small          50          89        560           0                  0
   medium        500         354       1413           0                  0
   large        2000        1084       1845           0                  0
   very_large  10000        4901       2040           0                  0

## Retrieval
   query                              ms      candidates   kept   context tokens
   why is the payment receipt parser    15            60      0             1724
   parseRecord_412                       0            40      0             1537

## Memory
   records    write (ms)    search (ms)    search p95 (ms)
       100           52          1.15             3.17
      1000          363          2.72             9.52
     10000         2163          3.67             5.25
     50000        12535         14.15            19.92

## Context
   2,000 messages   30,994 tokens
   compaction       19 ms
   summary          2,938 tokens (10.5x smaller)

## Large tool output
   input             8.8 MB
   processing        228 ms
   inline context    1,383 tokens (0.06% of input)
   errors extracted  10

33/33 checks passed in 29.5s
```

The checks are assertions, not just numbers: incremental indexing must touch one
file, retrieval must stay under a token ceiling, memory search p95 must stay under
250 ms at 50,000 records, compaction must preserve decisions, and diagnostics must
survive a spill. The benchmark exits non-zero if any check fails, so it works as a
regression gate.

## What the benchmarks caught

Two real defects, both found by running the numbers rather than by reading code:

1. **Concurrent appends opened one file handle each.** With thousands of queued
   memory writes this exhausted descriptors and throttled to a crawl. Appends are
   now serialised, which also guarantees offsets are recorded in disk order.
2. **Duplicate detection ran a BM25 search on every write.** BM25 scores every
   document containing a query term, so per-write cost grew with the store and bulk
   writes were quadratic — 10,000 records took 102 s. Exact-key deduplication
   through the catalog made it O(1): the same 10,000 records now take ~1.7 s, and
   50,000 take ~12.5 s.

A third issue was found the same way: the catalog was rewritten in full on every
write, which is quadratic I/O. It is now a debounced cache that rebuilds from the
log when it disagrees — a stale file costs one rebuild, never correctness.

## Adding a test

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { withScratch, testConfig } from './helpers.js';

test('memory survives a new store instance', async () => {
  await withScratch(async ({ projectRoot, home }) => {
    const config = testConfig();
    const first = await openWorkspace({ root: projectRoot, config });
    const record = await first.stores.memory.write({
      type: 'DECISION', scope: 'project', summary: 'Uses PostgreSQL',
      source_refs: [{ kind: 'message', conversation_id: 'conv_1', message_id: 'msg_1' }],
    });
    await first.flush();

    const second = await openWorkspace({ root: projectRoot, config });
    const found = await second.stores.memory.get(record.id);
    assert.equal(found?.summary, 'Uses PostgreSQL');
  });
});
```

Prefer asserting on behaviour the architecture promises — persistence, provenance,
isolation, degradation — over asserting on implementation detail. If a test needs a
provider, use `MockProvider`; if it needs a real process, use a short-lived command
and assert on the structured result, not on formatted output.
