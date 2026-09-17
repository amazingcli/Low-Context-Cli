# Development

## Terminal UI conventions

The interface is built from a few primitives in `src/cli/ui.ts`, so every
surface stays consistent and none of them re-implement width maths (which is how
boxes end up ragged):

| Primitive | Use |
| --- | --- |
| `visibleWidth(text)` | the only length function for layout — ANSI codes are zero-width |
| `box(title, rows)` | label/value panels (the session header, summaries) |
| `divider()` | closes a turn, full terminal width |
| `toolLine` / `toolResultLine` | `⏺ tool  args` and `⎿ ✓ result`, nested the way a reader scans |
| `alert(kind, message, fixes)` | errors and warnings, with the fix on its own dim line |
| `heading` / `table` / `keyValue` | output of the non-interactive commands |

Rules that keep it readable:

- **values are passed plain** to `box`; the primitive colours and pads them, so
  no caller ever pads a coloured string;
- **one line of metadata per turn** (`2.4s · 4 tools · ~1.8k tokens · ctx [██··] 18% · model`)
  instead of prose, and detail only under `--verbose` / `--debug`;
- the interactive input line is `prompt.ts`, not readline, because the slash menu
  needs the region under the cursor; key handling is unit-tested through
  `parseKeys` and `filterCommands`;
- anything that draws must degrade to plain text: no colour when stdout is not a
  TTY, and raw mode is only entered for real terminals.

## Setup

```bash
npm install
npm run build       # tsc -p tsconfig.json -> dist/
npm run typecheck   # tsc --noEmit
npm test            # build + node --test dist/tests/
npm run bench       # build + node dist/bench/run.js
npm run dev         # build + run the CLI
```

Node ≥ 18.17, TypeScript 5.5, ESM (`"type": "module"`). `tsc` emits `dist/` and the
`bin` shim runs `dist/src/cli/index.js`.

## Layout

```
src/
├── cli/          args.ts · ui.ts · commands.ts · chat.ts · wizard.ts · index.ts
├── agent/        workspace.ts · system-prompt.ts · loop.ts · verify.ts
├── retrieval/    intent.ts · engine.ts
├── memory/       engine.ts
├── index/        ignore.ts · analysis.ts · scanner.ts · project-map.ts ·
│                 index-store.ts · indexer.ts
├── search/       tokenize.ts · bm25.ts · rank.ts
├── context/      estimator.ts · builder.ts · compactor.ts
├── storage/      jsonl.ts · interfaces.ts · lexical-index.ts · *-store.ts ·
│                 vector-store.ts · embedder.ts
├── providers/    types.ts · http.ts · openai.ts · anthropic.ts · gemini.ts ·
│                 mock.ts · registry.ts
├── tools/        types.ts · permissions.ts · output.ts · registry.ts ·
│                 filesystem.ts · terminal.ts · project.ts · memory.ts · web.ts
├── security/     secrets.ts · redact.ts · injection.ts · guards.ts
├── git/          git.ts
└── core/         types.ts · ids.ts · errors.ts · util.ts · paths.ts ·
                  config.ts · logger.ts
tests/            node:test suites
bench/            benchmarks
```

## Conventions

**Dependency direction is one-way.** `cli → agent → {retrieval, context, tools,
memory, providers} → {index, search, storage} → core`. A lower layer importing an
upper one is a design bug.

**Every module opens with a header comment** stating its interface and data flow —
why it exists, what it promises and what it refuses to do. This is not decoration;
it is the contract for anything that changes it.

**Stable internal objects live in `core/types.ts`.** A new concept that crosses a
layer boundary belongs there, with a stable id prefix in `core/ids.ts`.

**Errors carry a code and a fix.** Throw `LowContextError` with a code from
`core/errors.ts` and, where possible, a `fix` string. The CLI prints the fix;
a stack trace is never the user's only clue.

**No runtime dependencies.** Anything that would need one goes behind an interface
with a local implementation, or is not added. This keeps installation offline and
removes a class of supply-chain risk.

**Interfaces before implementations.** Storage, providers, tools and the vector
store are all interfaces with a default local implementation, which is what makes
them replaceable.

**No placeholders that pretend to work.** If something is not implemented, it is
isolated behind its interface and returns an explicit "not supported" rather than a
plausible-looking fake. A retrieval layer that quietly returns recent messages
would be worse than one that admits it has no index.

## Adding a tool

```ts
// src/tools/mytool.ts
import { objectSchema, stringProp, toolResultFrom } from './types.js';
import type { ToolDefinition } from './types.js';

export const myTool: ToolDefinition = {
  name: 'my_tool',
  description: 'One sentence the model can act on.',
  schema: objectSchema({ path: stringProp('Project-relative path') }, ['path']),
  /** Classified as read-only, mutating or destructive — drives permissions. */
  risk: 'read',
  async execute(ctx, args) {
    const path = asString(args, 'path');
    const abs = resolveProjectPath(ctx, path);   // containment checked here
    return toolResultFrom(await doTheWork(abs));
  },
};
```

Then register it in `defaultTools()` in `src/tools/registry.ts`, choose a risk
level, and add a test. Permissions, output spilling, tracing and the UI display are
inherited — a tool does not implement any of that.

## Adding a provider

See [providers.md](providers.md). Implement `ChatProvider`, map errors to
`LowContextError` codes, add a `case` to `createProvider`, add the kind to
`ProviderKind`.

## Adding a storage backend

Implement the interface from `src/storage/interfaces.ts` (`MemoryStore`,
`IndexStore`, `ConversationStore`, …), and swap it in where the store is
constructed in `src/agent/workspace.ts`. Nothing above `workspace.ts` changes.

## Changing retrieval

`src/retrieval/engine.ts` is a pipeline of stages, each wrapped in `safe()` so one
failing stage degrades rather than aborts. To add a source:

1. generate `ScoreInputs` for the stage
2. add `indexMeta`-style metadata so the candidate can explain itself
3. note the stage in the trace with candidate/kept counts and duration
4. respect `config.retrieval.max_candidates`
5. add a ranking test that asserts the new signal changes an ordering

Ranking weights live in `core/types.ts` (`DEFAULT_WEIGHTS`) and are exposed in
config. If you add a signal, give it a weight rather than hard-coding behaviour.

## Performance

The storage layer is the usual bottleneck, and the benchmarks catch it:

- appends are serialised and open one file handle
- the `id → ordinal` catalog is a debounced cache, never rewritten per record
- duplicate detection is an O(1) key lookup, never a full-text scan
- the BM25 index is flushed on a debounce, not per document

Run `npm run bench` before and after a change to a hot path; the numbers in
[testing.md](testing.md) are the reference.

## Style

- TypeScript strict mode, no `any` without a comment explaining why
- Prefer explicit over clever; this code is read far more than it is written
- Asynchronous by default; never block the event loop in a hot path
- Comment the *why* — the code already says what

## Before you commit

```bash
npm run typecheck && npm test && npm run bench
```

All three must be clean.
