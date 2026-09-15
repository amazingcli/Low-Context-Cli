# Project indexing

The index answers one question quickly: **where** is the code that matters for this
request? It is a navigation structure, not a replacement for source (§4C). Nothing
important is ever decided from index metadata alone.

## What gets indexed

| Level | Data |
| --- | --- |
| Project | root, name, detected languages, module list |
| Module | directories with a coherent role, dominant language, file count |
| File | path, language, size, hash, mtime, purpose summary |
| Symbols | classes, functions, methods, exports, constants, routes |
| Dependencies | imports and reverse references |
| Structure | routes, API endpoints, schema references, entry points |
| Docs & config | manifests, config files, documentation |

Sensitive values are never indexed: `.env` contents, credentials and keys are
excluded, and metadata about environment configuration is limited to names.

## Analysis

`analysis.ts` extracts per-file metadata. Where the language is supported it uses
structural parsing (declarations, exports, imports, scopes) rather than regex
guessing; for other languages it falls back to carefully bounded heuristics and
marks the result as inferred rather than verified.

```
backend/payments/receipt.go
  language    go
  purpose     Receipt processing
  symbols     ReadReceipt, ParseReceipt, ValidateReceipt
  imports     database, storage
  dependents  routes/checkout.go, jobs/settle.go
  hash        3f9c…   indexed_at 2026-09-15T10:22:04Z
```

## Ignore rules

Layered, so a project can tighten but not silently widen the scan:

1. built-in never-index set — `node_modules`, `.git`, `dist`, `build`, `target`,
   `vendor`, `.venv`, `__pycache__`, `.next`, coverage output, `.low-context`
2. repository ignore conventions
3. `config.index.extra_ignore`

```json
{ "index": { "extra_ignore": ["fixtures/**", "**/*.snap", "legacy/"] } }
```

Guards: `max_file_bytes` (larger files are mapped, not parsed), symlinks are not
followed unless enabled, binary files are detected and skipped.

## Incremental refresh

The index is **not** rebuilt after every change (§5). Refresh:

1. scans the filesystem for the current file list
2. compares hash and mtime against the index
3. re-analyses only added or changed files
4. removes entries for deleted files
5. updates module summaries for affected directories

Measured on a synthetic repository of 10,000 files: cold index ~5.5s
(~2,000 files/s); after a single edit, incremental refresh re-analyses **1 file**
and completes in under a millisecond of analysis work.

```bash
lc index status     # counts, languages, staleness, last refresh
lc index refresh    # incremental
lc index rebuild    # full rebuild (drops and re-creates)
lc index drop       # remove the index for this project
```

## Stale detection

An index entry is stale when the recorded hash and mtime disagree with the file on
disk. Staleness:

- lowers a candidate's ranking score
- is reported in `lc index status` and the retrieval trace
- is corrected on read: **the source wins**, and the entry is updated
- forces a re-read before any edit that depends on the file's content

```bash
lc index status
  files        1,284
  modules         41
  symbols      9,871
  stale            2   (run `lc index refresh`)
  last refresh 2026-09-15T10:22:04Z
```

## The hierarchical map

The map is hierarchical on purpose, because the whole thing never needs to be in
context (§6):

```
project → module → directory → file → symbol
```

Retrieval pulls the levels the request needs:

```
"Fix payment receipt parsing"
  → payments module
      → receipt.go
          → ParseReceipt()
              → related tests
```

Unrelated files are not injected.

## Whole-project analysis

`lc analyze` deliberately does **not** put the tree in context (§31):

```
1. scan the project
2. build/update the index
3. identify modules and their roles
4. rank important files (size, connectivity, entry points, routes)
5. inspect representative source for each module
6. build the architecture summary
7. identify dependencies between modules
8. record unknowns explicitly
9. retrieve deeper source only where the model asks
```

The result is a bounded summary plus a map the model can navigate with further
retrieval — not a dump.

## Commands

```bash
lc index                     # refresh
lc index status
lc index rebuild
lc map                       # tree, truncated to what fits
lc map tree --depth 3
lc map file payments/receipt.go
lc map module payments
lc files list
lc files show payments/receipt.go
lc search "parse receipt"
```

## Storage

```
<project>/.low-context/index/
├── index.json          project record, modules, file metadata, symbol table
└── (BM25 sidecars)     lexical index over paths, symbols and summaries
```

Deleted with `lc index drop`; rebuilt with `lc index rebuild`. Both are safe: the
index is derived data and never the only copy of anything.
