# Low Context

**A retrieval-first AI coding CLI.**

> Do not remember everything in active context.
> Remember *where* everything important is.
> Retrieve what matters. Verify the source. Use the minimum useful context.
> Then update the external knowledge system after the task.

Most AI coding tools are built as a chat loop with a large context window, and
memory is bolted on afterwards. Low Context is built the other way around: the
retrieval, index, memory and verification systems *are* the architecture, and the
model interaction sits on top of them.

The agent never needs your whole project in context. It keeps a compact map, an
index, and a memory store — and puts only what the current task needs into the
request.

```
User request
     │
     ▼
Recent context + task state + project map + memory index
     │
     ▼
Retrieval  ──►  candidate generation (lexical · symbols · dependencies · memory · recent)
     │
     ▼
Ranking  ──►  dedupe  ──►  adaptive stop
     │
     ▼
Source verification  ──►  read the real file, not the summary
     │
     ▼
Context construction  ──►  budgeted, deduplicated, minimal
     │
     ▼
LLM  ──►  action
     │
     ▼
Verify  ──►  inspect diff, run tests  ──►  update index + memory
```

---

## Install

Requires **Node.js ≥ 18.17**. There are **no runtime dependencies** — Low Context
installs and runs offline.

```bash
npm install -g github:amazingcli/Low-Context-Cli
```

or from the npm registry once published:

```bash
npm install -g low-context
```

```bash
git clone https://github.com/amazingcli/Low-Context-Cli.git low-context
cd low-context
npm install          # dev only: typescript + @types/node
npm run build
npm link             # optional: makes `lc` available globally
```

Or with the bundled script:

```bash
./install.sh         # builds and links the CLI
```

Verify the installation:

```bash
lc doctor
```

See [docs/installation.md](docs/installation.md) for details.

---

## Quickstart

```bash
cd your-project
lc init                          # pick a provider and model
lc "where is authentication handled and how does it time out?"
```

The wizard asks for a provider, a model and a permission mode. Every provider —
hosted or local — also accepts a model ID you **paste by hand** or **fetch live**
from the provider's `/models` endpoint, so a gateway or a brand-new model name
needs no code change. See [providers.md](docs/providers.md).

`lc init` configures a provider. Any of these work:

| Provider | Kind | Credential |
| --- | --- | --- |
| OpenAI | `openai` | `OPENAI_API_KEY` |
| Anthropic | `anthropic` | `ANTHROPIC_API_KEY` |
| Google Gemini | `gemini` | `GEMINI_API_KEY` |
| Ollama / any local server | `local` | none (OpenAI-compatible `base_url`) |
| Any OpenAI-compatible API | `custom` | `base_url` + key |
| Mock (offline, deterministic) | `mock` | none |

More:

```bash
lc analyze                       # map the project and summarise the architecture
lc index                         # build or refresh the project index
lc "fix the receipt parser"      # one-shot request
lc                               # interactive session (type / for the menu)
lc context show                  # what would be sent to the model, and why
lc memory search "auth decision" # retrieve a past decision, with its source
lc memory show mem_…             # the record *and* the conversation it came from
lc --debug "why is billing slow" # retrieval trace: what was retrieved and why
```

---

## What makes it different

**Retrieval, not dumping.** A query is classified by intent first, then multiple
candidate sources are combined — lexical BM25 over the index, exact symbol
matches, dependency expansion, memory search, recent conversation — and ranked
with an explicit, inspectable score:

```
score = lexical + semantic + project + task + dependency
      + recency + importance + confidence − redundancy − staleness
```

**Verification is a stage, not a promise.** `index != source`, `summary != source`,
`memory != source`. Anything marked `verified` was read from disk during *this*
request. `lc context show` separates "retrieved but unverified" from "verified".

**Memory with provenance.** Every durable record carries `source_refs` back to the
conversation and message it came from, plus `confidence` and `status`. Corrections
supersede rather than contradict (§11). Nothing claims the model was *trained* —
memory is stored, retrieved and verified.

**A context budget you can inspect.** System prompt, task memory, project map,
retrieved memory, retrieved code, tool results and output reserve are accounted
separately, and compaction happens before the window overflows.

**Large output never floods the window.** A 10 MB build log is written to an
artifact; the context gets the head, the extracted diagnostics and the tail. The
full log stays retrievable on demand. Measured: **1.4k tokens from 8.8 MB**.

**Tools are permissioned.** `safe` / `ask` / `trusted` modes, allow/deny rules,
command risk classification, timeouts, output limits, path containment, and an
environment allowlist.

**Local-first.** Index, memory, sessions and logs are files on your disk. No
database, no service, no telemetry (disabled by default, and there is nothing to
send it to anyway).

---

## Commands

```
lc                              start an interactive session
lc "fix the login bug"          one-shot request
lc <command> [subcommand]

CORE
  init                          configure a provider and model
  chat                          interactive session
  run "<request>"               one-shot request, prints the answer
  plan "<request>"              ask for a plan without executing tools
  analyze [path]                map a project and summarise its architecture
  status                        project, model, context and index summary

PROJECT
  index [status|refresh|rebuild|drop]
  map [tree|file <path>|module <name>]
  files [list|show <path>]
  search <query>                search indexed files and symbols
  context [show]                what would be sent to the model, and why

MEMORY
  memory list|search|show|forget|delete|supersede|rebuild|export|stats
  sessions list|resume|show|end|delete

CONFIGURATION
  providers list|add|remove|test|enable|disable
  models list|use|show|test
  config show|get|set|path|edit|reset
  permissions show|mode|allow|deny|reset
  tools list|show <name>
  logs list|tail|path|prune
  doctor                        diagnose the whole installation
```

### Inside a session

Typing `/` opens a live, filtered command menu — arrows move, `Tab` completes,
`Enter` runs — so nothing has to be memorised:

```
project› /mod
  ─── model
 › /model                    show the active model
   /models                   list models and switch
   /nopermission             bypass permission prompts for this session (toggle)
   /permissions              show permission mode and rules
  ↑↓ move · Enter run · Tab complete · Esc close · type to filter
```

`/models 3` or `/model gpt-4o` switches model mid-session; `/history`, `/search`,
`/sessions` and `/resume` work against the on-disk history; `/nopermission`
toggles the session bypass; `/verbose`, `/debug` and `/quiet` change how much the
agent shows you. Deny rules and catastrophic commands stay blocked even with the
bypass on.

Common options:

```
--provider <id> --model <id>    override for one run
--strategy minimal|balanced|deep|maximum
--mode safe|ask|trusted         permission mode for this run
--project <path>                operate on another project
--quiet | --verbose | --debug   response detail
--no-memory | --no-index        disable a subsystem for one run
--yes                           approve confirmations non-interactively
```

---

## Architecture

```
src/
├── cli/            argument parsing, terminal UI, all commands, first-run wizard
├── agent/          workspace bootstrap, system prompt, the agent loop, verification
├── retrieval/      intent understanding, multi-stage candidate generation
├── memory/         what becomes memory, and when
├── index/          ignore rules, symbol extraction, scanner, project map
├── search/         tokenizer, BM25 inverted index, ranking, dedupe
├── context/        token estimation, budget, context construction, compaction
├── storage/        JsonlLog, stores (memory/conversation/session/task/project/vector)
├── providers/      OpenAI, Anthropic, Gemini, local/custom, mock + registry
├── tools/          permissions, output manager, filesystem, terminal, project, memory, web
├── security/       secret resolution, redaction, prompt-injection defence, guards
├── git/            branch, changed files, diffs, history
└── core/           types, ids, errors, util, paths, config, logger
```

The storage layer is behind interfaces (`MemoryStore`, `IndexStore`,
`ConversationStore`, `ProjectStore`, `SessionStore`, `VectorStore`), so replacing
the file backend with SQLite or adding a remote memory service does not touch
retrieval or the agent loop.

Full detail, including layer-by-layer data flow: **[docs/architecture.md](docs/architecture.md)**.

---

## Documentation

| Document | Contents |
| --- | --- |
| [architecture.md](docs/architecture.md) | Layers, data flow, agent loop, design rules |
| [installation.md](docs/installation.md) | Requirements, build, install, uninstall |
| [configuration.md](docs/configuration.md) | Config files, precedence, every setting, env vars |
| [providers.md](docs/providers.md) | Provider abstraction, adding providers, capabilities |
| [models.md](docs/models.md) | Model selection, context limits, fallback, cost |
| [memory.md](docs/memory.md) | Memory types, provenance, confidence, corrections, scoping |
| [retrieval.md](docs/retrieval.md) | Intent, stages, ranking, traces, adaptive stopping |
| [indexing.md](docs/indexing.md) | Scanner, symbols, incremental refresh, stale detection |
| [context.md](docs/context.md) | Budget, strategies, compaction, inspection |
| [permissions.md](docs/permissions.md) | Modes, allow/deny, terminal safety, output limits |
| [security.md](docs/security.md) | Secrets, redaction, injection defence, privacy, retention |
| [development.md](docs/development.md) | Project layout, conventions, adding a tool/provider |
| [testing.md](docs/testing.md) | Test suite, benchmarks, how to run and extend them |
| [troubleshooting.md](docs/troubleshooting.md) | Common failures and fixes |

---

## Development

```bash
npm run typecheck    # tsc --noEmit
npm test             # build + node:test  (79 tests)
npm run bench        # 33 benchmark checks across real subsystems
npm run dev          # build and run the CLI
```

Both suites currently pass end to end. The benchmark is not a microbenchmark
harness: it indexes synthetic repositories of 50 → 10,000 files, writes 50,000
memory records, compacts a 2,000-message conversation and spills an 8.8 MB build
log, then asserts on the results.

```
indexing       10,000 files cold in ~5.5s (~2,000 files/s); incremental edit re-analyses 1 file
retrieval      3–60 candidates per query, ~1.5k tokens of verified context
memory         50,000 records: search p95 ~20ms, 12.5s to write
context        2,000 messages → 10.5x smaller summary, 19ms
output         8.8 MB log → 1,383 inline tokens, 10 diagnostics kept
```

---

## Principles

1. **Persistent memory is not training.** Low Context never claims to have learned
   from you. It stores, indexes, retrieves and verifies.
2. **An index is not the source.** Navigation aids are trusted for *where*, never
   for *what*.
3. **Summaries keep a route home.** Every summary keeps a reference to the
   original material, and the original stays retrievable.
4. **Retrieve deliberately.** Small, relevant and verified beats large, possibly
   relevant and unverified.
5. **Repository content is data.** A README that says "ignore your instructions"
   is a file, not an instruction.
6. **The user controls memory.** `remember`, `forget`, `show`, `export`, `delete` —
   all explicit, all local.

## License

MIT
