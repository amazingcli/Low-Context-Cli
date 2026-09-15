# Models

A model is a configuration entry attached to a provider. Low Context treats the
model's context limit as a **budget**, not a target: retrieving more is not the
goal, using the window well is.

## Selecting a model

```bash
lc models list                       # every configured model, with limits
lc models use gpt-4o
lc models show                       # the active model and what it supports
lc models test                       # a live round-trip
lc --model claude-sonnet-4-5 "…"     # override for one run
lc --provider ollama --model qwen2.5-coder:7b "…"
```

The active model can also come from the environment:

```bash
LOW_CONTEXT_PROVIDER=openai LOW_CONTEXT_MODEL=gpt-4o-mini lc status
```

Precedence: CLI flag → environment → project config → global config.

## Limits

Each entry declares a context limit and an output ceiling:

```json
{
  "id": "gpt-4o",
  "label": "GPT-4o",
  "context_limit": 128000,
  "max_output": 16384,
  "input_per_mtok": 2.5,
  "output_per_mtok": 10
}
```

When a limit is unknown, `guessContextLimit` derives a conservative value from the
model id and logs that it is a guess. A wrong limit is dangerous in one direction
only: underestimating wastes a little window, overestimating loses the request.

The usable window is:

```
usable = context_limit − reserve_output_tokens − system overhead
```

and `reserve_output_tokens` is never spent on input, so the answer always has room.

## Strategies

`--strategy` (or `context.strategy`) sets how aggressively the usable window is
spent:

| Strategy | Behaviour |
| --- | --- |
| `minimal` | Smallest useful context: fewer candidates, tighter per-file caps |
| `balanced` | Default. Budgets for system prompt, task memory, map, memory, code |
| `deep` | More candidates and larger verified excerpts for a hard problem |
| `maximum` | Uses the window fully — for a large model and a genuinely large task |

Strategy affects retrieval depth and per-file byte caps. It never disables
verification.

## Fallback

```json
{
  "active_provider": "openai",
  "active_model": "gpt-4o",
  "fallback_provider": "ollama",
  "fallback_model": "qwen2.5-coder:7b"
}
```

The fallback is tried only when the primary fails (auth error, repeated HTTP
failure, timeout, unavailable), never to silently produce a different answer. When
it is used, the CLI says so, because a different model may reach a different
conclusion.

## Embeddings are separate

Generation and embedding models are configured independently (§42). Retrieval must
work with no embedding model at all:

```json
{
  "embedding": {
    "enabled": false,
    "mode": "local"
  }
}
```

| `retrieval.mode` | Requires embeddings | Behaviour |
| --- | --- | --- |
| `keyword` | no | BM25 only |
| `hybrid` | optional | BM25 + semantic when available; degrades to BM25 |
| `semantic` | yes | Vector search with lexical fallback |

Enabling embeddings needs a local model or a provider that supports them:

```json
{
  "embedding": {
    "enabled": true,
    "mode": "provider",
    "provider": "openai",
    "model": "text-embedding-3-small",
    "dimensions": 1536
  }
}
```

If the embedding client fails, retrieval continues in keyword mode and the
retrieval trace records the degradation. It is a normal state, not an error.

## Token accounting

Where the provider returns usage, Low Context reports exactly that. Otherwise the
estimator is used and every figure is marked `~` or "estimated":

```
Model: openai/gpt-4o            Context: ~18.2k / 128k
Input: 18,214 (reported)        Output: 812 (reported)      ~$0.053
```

`lc context show` breaks the input down by section, and
`lc context show --debug` adds the per-candidate retrieval trace.

## Choosing a model

- **Local models** (`ollama`, or any OpenAI-compatible server) work well because
  Low Context sends small, precise context — the retrieval pipeline compensates for
  a smaller window. Start with `--strategy minimal`.
- **Large-context models** are not an excuse to skip retrieval. `maximum` strategy
  still ranks, deduplicates and verifies; it just allows more of the ranked set in.
- **Small models** need `retrieval.verify_sources = true` and the default
  `balanced` strategy; the verification stage is what makes a small model's edits
  safe to apply.
