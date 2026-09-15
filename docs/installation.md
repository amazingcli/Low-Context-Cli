# Installation

## Requirements

| Requirement | Notes |
| --- | --- |
| **Node.js ≥ 18.17** | ESM, `node:test`, `node:readline/promises`. Tested on Node 18 and 20. |
| A filesystem | Local-first by design; no database or daemon. |
| A provider credential | Only for real models. `ollama` (local) and `mock` need none. |

There are **no runtime dependencies**. `typescript` and `@types/node` are dev
dependencies only, so an installed copy runs offline and cannot break because a
transitive package changed.

## Install from source

```bash
git clone https://github.com/amazingcli/Low-Context-Cli.git low-context
cd low-context
npm install       # dev dependencies
npm run build     # tsc -> dist/
npm link          # optional: puts `lc` and `low-context` on your PATH
```

If you would rather not link globally, run the entry point directly:

```bash
node bin/low-context.js --help
```

## Install with the script

```bash
./install.sh
```

`install.sh` installs dependencies (skipped when `node_modules` is present with
`--offline`), builds, and links the CLI. It does not modify anything outside the
project directory or your npm global prefix.

## Verify

```bash
lc version
lc doctor
```

`lc doctor` checks every subsystem and prints a fix for anything that fails:

```
Low Context diagnostics
───────────────────────────
OK    CLI              low-context 0.1.0 on node v18.19.1
OK    Config           loaded from ~/.low-context/config/config.json
FAIL  Provider         no active provider
      fix: Run `lc init` or `lc providers list`
FAIL  Model            no model selected
      fix: Run `lc models use <model-id>`
OK    Project index    82 file(s), up to date
OK    Memory store     0 record(s) for this project
OK    Tools            26 tool(s) available
OK    Search           index search responded
OK    Filesystem       writable: /home/you/project/.low-context
OK    Terminal         shell responded in 10 ms
OK    Embeddings       disabled — keyword/hybrid retrieval only (this is supported)
```

A missing provider is a normal state on a fresh install, not a broken one.

## First run

```bash
cd your-project
lc init
```

The wizard lists known providers and their credential environment variables,
writes the provider and model into your configuration, and offers to build the
project index. You can also configure everything by hand — see
[configuration.md](configuration.md) and [providers.md](providers.md).

## Where state lives

```
$LOW_CONTEXT_HOME/            (default: ~/.low-context)
├── config/
│   ├── config.json           global configuration
│   ├── providers/            per-provider config
│   ├── models/               per-model config
│   └── credentials.json      0600, secrets resolved from env by default
├── memory/                   global memory
├── indexes/                  shared indexes
├── projects/                 centralised per-project state
├── sessions/
├── logs/
├── cache/
└── artifacts/                spilled tool output

<project>/.low-context/       (per-project, unless storage.project_local = false)
├── config.json               project overrides (safe to commit)
├── project.json              project record
├── index/
├── memory/
├── sessions/
├── cache/
└── artifacts/
```

Set `LOW_CONTEXT_HOME` to relocate global state — useful for tests, containers
and keeping several configurations side by side:

```bash
LOW_CONTEXT_HOME=~/work/lc-home lc status
```

Add `.low-context/` to the project's `.gitignore` to keep local state out of
version control, or set `storage.project_local = false` to keep the working tree
completely clean and store state under `$LOW_CONTEXT_HOME/projects` instead.

## Upgrading

```bash
git pull
npm install
npm run build
```

Config has a `version` field and is merged forward; unknown keys are preserved.

## Uninstall

```bash
./uninstall.sh              # removes the global link
npm unlink -g low-context   # or do it manually
```

Project state is ordinary files. Remove it explicitly:

```bash
lc config reset             # reset configuration to defaults
lc memory rebuild           # rebuild the memory index
rm -rf <project>/.low-context
rm -rf "$LOW_CONTEXT_HOME"
```

## Troubleshooting

See [troubleshooting.md](troubleshooting.md) for the common cases: no provider
credential, index not built, terminal blocked by permissions, provider HTTP
errors.
