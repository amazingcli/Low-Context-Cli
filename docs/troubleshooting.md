# Troubleshooting

Start here:

```bash
lc doctor          # checks every subsystem, prints a fix for anything wrong
lc --debug "…"     # retrieval trace, context accounting, tool details
lc logs tail       # structured logs
```

`lc doctor` output is the fastest path to an answer — each failing line carries the
command that fixes it.

---

## "no active provider" / "no model selected"

`lc doctor` reports these on a fresh install. They are configuration states, not
breakage.

```bash
lc init                      # wizard
# or
lc providers list            # see what is available and which credentials resolve
export OPENAI_API_KEY=…
lc providers test openai
lc models use gpt-4o
```

If `lc providers test` says the credential is missing, check the variable name in
`lc providers list` — it is per provider (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`,
`GEMINI_API_KEY`), and it must be exported in the shell that runs `lc`.

## Provider returns an authentication error

- Confirm the variable is visible to the process: `lc providers list` shows
  credential status without printing the value.
- If you store credentials in `$LOW_CONTEXT_HOME/config/credentials.json`, confirm
  `api_key_ref` matches the key path (`providers.openai.api_key`).
- Some providers distinguish "invalid key" from "key lacks access to this model" —
  `lc models test` says which.

Codes: `PROVIDER_AUTH`, `PROVIDER_HTTP`, `PROVIDER_TIMEOUT`. See
[providers.md](providers.md).

### "Expected OAuth 2 access token" (Google) or a 401 from Anthropic

The key is fine — the header is wrong. Each API requires its own auth header
(`Authorization: Bearer` for OpenAI-compatible, `x-api-key` for Anthropic,
`x-goog-api-key` for Gemini), and a mismatched one is rejected with `401` even
when the key is valid. Current builds send the right header per provider kind, so
if you see this, check what kind the endpoint is configured as:

- routing an Anthropic or Gemini model through a proxy? configure the proxy as
  `custom` (OpenAI-compatible) if it speaks that dialect;
- a hand-written entry with wrong `kind` will show it in `lc providers list`;
- `lc providers test <id>` reports which header and URL were used.

## Provider times out or errors repeatedly

```bash
lc config set generation.fallback_provider ollama
lc config set generation.fallback_model qwen2.5-coder:7b
lc config set providers.openai.timeout_ms 180000
```

The fallback is used only after a real failure, and the CLI says when it is used.
For offline work, point at a local server:

```bash
lc providers test ollama
lc --provider ollama --model qwen2.5-coder:7b "explain this project"
```

## Retrieval returns nothing useful

Check what was actually retrieved and why:

```bash
lc --debug "your question"
lc context show --debug
lc search "a phrase you expect to match"
lc index status
```

Common causes:

| Symptom | Cause | Fix |
| --- | --- | --- |
| No candidates at all | Index never built | `lc index refresh` |
| Few candidates | Index stale | `lc index refresh` |
| Wrong files | Query is too broad | Ask more specifically, or raise `--strategy deep` |
| Right file, low rank | Symbol names not matching | `lc config set retrieval.weights.exact 0.25` |
| Context too small | `minimal` strategy | `--strategy balanced` or `deep` |
| Files missing entirely | Ignore rules | `lc config set index.extra_ignore []` and check `index.status` |

Remember the two-stage honesty: an *indexed* candidate is a pointer; a *verified*
candidate was read from disk. `lc context show` distinguishes them.

## The index is stale or wrong

```bash
lc index status     # shows the stale count
lc index refresh    # incremental, re-analyses only what changed
lc index rebuild    # full rebuild if something is genuinely wrong
lc index drop       # start over
```

The index is derived data — deleting it loses nothing but time. If the source
disagrees with the index, the source wins and the entry is corrected on read.

Large files (> `index.max_file_bytes`, default 512 KB) are mapped rather than
parsed. Raise the limit if you need deep analysis of a large generated file:

```bash
lc config set index.max_file_bytes 2097152
```

## Commands are blocked

```
permission denied: run_command "rm -rf build"
```

The permission mode or a deny rule refused it. Inspect the policy:

```bash
lc permissions show
lc permissions mode trusted
lc --mode trusted "clean and rebuild"
```

Deny rules always win over the mode — if something is listed under `deny`, remove
the rule rather than raising the mode. To run non-interactively in CI, `--yes`
approves confirmations without bypassing denies. See
[permissions.md](permissions.md).

## A command times out

```bash
lc config set permissions.timeout_ms 300000
```

The process is killed on expiry and you get partial output plus the exit status, so
a timeout is diagnosable rather than silent.

## Huge command output swamps the answer

It should not — large output is spilled to an artifact and only the head,
diagnostics and tail enter context. If you want the whole thing:

```bash
lc logs tail
ls "$LOW_CONTEXT_HOME/artifacts"          # or <project>/.low-context/artifacts
```

The artifact path is printed inline as `[output 8.8 MB — full copy at …]`.

## Session resume loses detail

That is by design (§27): a resumed session restores the summary, task state and
memory, not the raw transcript. The transcript is still on disk:

```bash
lc sessions list
lc sessions show <id>            # the summary and task state
lc memory search "<topic>"       # the decisions from that session
```

If something important is missing, it was probably never captured as a memory
record. Say "remember: …" to store it explicitly, and check `lc memory stats`.

## Context is filling up

```bash
lc context show                  # what is taking the space
lc --strategy minimal "…"
lc config set context.compaction_threshold 0.6
lc config set context.keep_recent_messages 8
```

Compaction preserves decisions as memory records, so shrinking the window does not
mean losing the decisions.

## Memory is wrong or unwanted

```bash
lc memory search "the thing"
lc memory show <id> --source     # what it was derived from
lc memory delete <id>
lc memory forget "old staging credentials"
```

Supersede rather than delete when a fact *changed*:

```bash
lc memory supersede <old-id> --with <new-id>
```

Nothing was ever "learned" by a model, so removing a record removes it completely.

## Config change had no effect

Check the effective value and where it comes from — precedence is defaults → global
→ project → environment → flags:

```bash
lc config show
lc config get context.strategy
lc config path
```

A project `.low-context/config.json` overrides your global setting, and a
`LOW_CONTEXT_*` variable overrides both.

## Something is broken and I want a clean slate

```bash
lc config reset
rm -rf <project>/.low-context      # project index, memory, sessions
lc index refresh                   # rebuilds the index
```

To also clear global state:

```bash
rm -rf "$LOW_CONTEXT_HOME"
```

## Reporting a bug

Run the failing case with `--debug`, then include:

- `lc version` and `node --version`
- `lc doctor` output
- the `--debug` trace

That is usually enough to tell whether the problem is in retrieval, context
construction, a provider, or the permission layer — which is most of the diagnosis.
