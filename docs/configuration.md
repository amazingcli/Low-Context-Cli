# Configuration

## Precedence

Lowest to highest:

```
1. built-in defaults
2. global config     $LOW_CONTEXT_HOME/config/config.json
3. project config    <project>/.low-context/config.json
4. environment       LOW_CONTEXT_*
5. CLI flags         --model, --strategy, --mode, --project, --yes, …
```

Objects are deep-merged; **arrays are replaced, not concatenated**, so `providers`
and permission `allow`/`deny` lists behave predictably when a project overrides them.

Project config is intended to be committed: it makes "this repo uses Ollama with a
small context" a property of the repository rather than of your machine.

## Inspecting and editing

```bash
lc config show                      # effective config (secrets never printed)
lc config get context.strategy
lc config set context.strategy deep
lc config set retrieval.top_k 20
lc config path                      # where each file is
lc config edit                      # $EDITOR on the global config
lc config reset                     # back to defaults
```

`lc config show` prints the *effective* value after merging, so it is the fastest
way to answer "why is it doing that?".

## Secrets

Secrets are never written into `config.json`. A provider references credentials by
name:

```json
{
  "id": "openai",
  "kind": "openai",
  "api_key_env": "OPENAI_API_KEY",
  "api_key_ref": "providers.openai.api_key"
}
```

`api_key_env` is checked first, then `api_key_ref` resolves against
`$LOW_CONTEXT_HOME/config/credentials.json`. Values resolved from the environment
are never logged, never echoed, and are redacted from anything written to logs or
memory. See [security.md](security.md).

```bash
export OPENAI_API_KEY=…                        # recommended
lc providers test openai                       # confirms it resolves
```

## Reference

### `generation`

| Key | Default | Meaning |
| --- | --- | --- |
| `max_output_tokens` | `8192` | Output ceiling per request |
| `temperature` | — | When the provider supports it |
| `fallback_provider` / `fallback_model` | — | Used only on failure (§76) |

### `retrieval`

| Key | Default | Meaning |
| --- | --- | --- |
| `mode` | `hybrid` | `keyword`, `hybrid` or `semantic` |
| `top_k` | `12` | Candidates kept after ranking |
| `adaptive` | `true` | Stop retrieving once evidence is sufficient |
| `sufficient_verified` | `5` | Verified candidates that trigger the stop |
| `verify_sources` | `true` | Read candidate files from disk |
| `max_candidates` | `240` | Hard ceiling on candidate generation |
| `weights` | see below | Ranking weights |

Default ranking weights:

```json
{ "lexical": 0.30, "semantic": 0.22, "recency": 0.14, "importance": 0.10,
  "confidence": 0.08, "exact": 0.16, "task": 0.10, "staleness": 0.20,
  "redundancy": 0.25 }
```

Every input is normalised to `0..1` before weighting, so changing one weight has a
predictable effect. `lc context show --debug` prints the per-candidate components.

### `context`

| Key | Default | Meaning |
| --- | --- | --- |
| `strategy` | `balanced` | `minimal`, `balanced`, `deep`, `maximum` |
| `reserve_output_tokens` | `8192` | Held back from the window for the answer |
| `compaction_threshold` | `0.7` | Fraction of the usable window that triggers compaction |
| `keep_recent_messages` | `12` | Always kept verbatim |
| `auto_compact` | `true` | Compact without asking |
| `max_retrieved_file_bytes` | `131072` | Cap on a single verified file put in context |

### `memory`

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master switch |
| `auto_capture` | `true` | Capture memory from verified events |
| `min_importance` | `normal` | Floor for what a search may return |
| `retention_days` | `0` | `0` keeps records forever |
| `consolidate_after_messages` | `40` | Session length that triggers consolidation |

### `index`

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master switch |
| `max_file_bytes` | `524288` | Files above this are mapped, not parsed |
| `follow_symlinks` | `false` | Symlinks are not followed by default |
| `extra_ignore` | `[]` | Additional ignore globs |
| `refresh_on_start` | `true` | Refresh when a session starts |

### `permissions`

| Key | Default | Meaning |
| --- | --- | --- |
| `mode` | `ask` | `safe`, `ask`, `trusted` |
| `allow` / `deny` | `[]` | Tool and command rules; deny always wins |
| `timeout_ms` | `120000` | Command timeout |
| `max_output_bytes` | `524288` | Output ceiling before spilling |
| `allow_outside_project` | `false` | Path containment |
| `env_allowlist` | `[]` | Environment variables passed to commands |
| `require_confirmation_for_destructive` | `true` | Confirm deletions etc. |

Full detail: [permissions.md](permissions.md).

### `ui`

| Key | Default | Meaning |
| --- | --- | --- |
| `response_mode` | `normal` | `quiet`, `normal`, `verbose`, `debug` |
| `color` | `auto` | `auto`, `always`, `never` |
| `stream` | `true` | Stream tokens when the provider supports it |
| `show_retrieval` | `true` | Show what is being retrieved |
| `show_token_usage` | `true` | Input/output/context/cost |
| `show_context_bar` | `true` | Context usage indicator |
| `spinner` | `true` | Progress indicators |

### `storage`

| Key | Default | Meaning |
| --- | --- | --- |
| `project_local` | `true` | `false` → state under `$LOW_CONTEXT_HOME/projects` |

### `privacy`

| Key | Default | Meaning |
| --- | --- | --- |
| `telemetry` | `false` | Off; there is no telemetry endpoint |
| `redact_secrets` | `true` | Redact credentials and tokens in stored text |
| `log_prompts` | `false` | Prompts are not logged by default |

### `security`

| Key | Default | Meaning |
| --- | --- | --- |
| `injection_defense` | `true` | Treat repository text as untrusted data |
| `tag_untrusted_content` | `true` | Boundary-tag retrieved content |
| `max_retrieved_file_bytes` | `131072` | Cap on retrieved source |
| `scan_for_injection_patterns` | `true` | Flag override attempts |

### `web`

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `false` | Off by default |
| `endpoint` | — | Search endpoint |
| `api_key_env` | — | Credential environment variable |
| `max_results` | `5` | Results per search |

### `verification`

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Re-read changes and run configured tests after edits |
| `paths` | `[]` | Test commands to run after a change |

### `tools`

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `[]` | Empty means "the default set" |
| `disabled` | `[]` | Removed from the registry |

## Environment variables

| Variable | Effect |
| --- | --- |
| `LOW_CONTEXT_HOME` | Relocate global state |
| `LOW_CONTEXT_PROVIDER` / `LOW_CONTEXT_MODEL` | Active provider/model |
| `LOW_CONTEXT_FALLBACK_PROVIDER` / `LOW_CONTEXT_FALLBACK_MODEL` | Fallback |
| `LOW_CONTEXT_TEMPERATURE` | Sampling temperature |
| `LOW_CONTEXT_MAX_OUTPUT_TOKENS` | Output ceiling |
| `LOW_CONTEXT_CONTEXT_STRATEGY` | `minimal`/`balanced`/`deep`/`maximum` |
| `LOW_CONTEXT_RETRIEVAL_MODE` | `keyword`/`hybrid`/`semantic` |
| `LOW_CONTEXT_PERMISSION_MODE` | `safe`/`ask`/`trusted` |
| `LOW_CONTEXT_RESPONSE_MODE` | `quiet`/`normal`/`verbose`/`debug` |
| `LOW_CONTEXT_COLOR` / `LOW_CONTEXT_NO_COLOR` | Colour control |
| `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, … | Provider credentials |

Values that fail validation are ignored in favour of the configured value rather
than crashing — a typo in an environment variable must not break the CLI.

## Example: project config

```json
{
  "version": 1,
  "active_provider": "ollama",
  "active_model": "qwen2.5-coder:7b",
  "context": { "strategy": "minimal" },
  "retrieval": { "top_k": 8, "adaptive": true },
  "index": { "extra_ignore": ["fixtures/**", "*.snap"] },
  "permissions": {
    "mode": "safe",
    "deny": ["run_command:rm *", "write_file:infra/**"]
  },
  "privacy": { "log_prompts": false }
}
```

## One-off overrides

Anything configurable is overridable per run:

```bash
lc --model claude-sonnet-4-5 --strategy deep "audit the auth flow"
lc --mode safe "what does this project do?"
lc --no-index --no-memory "explain this file"
lc --project ~/work/api status
```
