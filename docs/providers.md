# Providers

Low Context never hard-codes a provider. Everything that talks to a model goes
through the `ChatProvider` interface, and the rest of the application does not
know provider kinds exist.

## The interface

```ts
interface ChatProvider {
  readonly id: string;
  readonly kind: ProviderKind;

  authenticate(): Promise<AuthStatus>;
  listModels(): Promise<ModelDescriptor[]>;
  capabilities(model?: string): ProviderCapabilities;

  generate(request: GenerateRequest, options?: { signal?: AbortSignal }): Promise<GenerateResult>;
  stream?(request: GenerateRequest, options?: { signal?: AbortSignal }): AsyncIterable<StreamChunk>;

  contextLimit(model: string): number;
  countTokens?(text: string): number | undefined;   // exact counting when available
}
```

`capabilities()` reports what the provider actually supports rather than what the
protocol allows:

```ts
interface ProviderCapabilities {
  streaming: boolean;
  tool_calling: boolean;
  parallel_tool_calls: boolean;
  vision: boolean;
  embeddings: boolean;
  structured_output: boolean;
  system_prompt: boolean;
  reasoning: boolean;
  max_context: number;
}
```

The agent loop consults capabilities before relying on a feature: no streaming →
one blocking response; no tool calling → tools are not offered and the model is
asked for a plan instead. Providers that partially report capabilities can be
corrected per model in config.

## Bundled providers

| Kind | Client | Typical endpoint |
| --- | --- | --- |
| `openai` | `OpenAIProvider` | `https://api.openai.com/v1` |
| `anthropic` | `AnthropicProvider` | `https://api.anthropic.com/v1` |
| `gemini` | `GeminiProvider` | `https://generativelanguage.googleapis.com/v1beta` |
| `local` | `OpenAIProvider` | `http://127.0.0.1:11434/v1` (Ollama by default) |
| `custom` | `OpenAIProvider` | any OpenAI-compatible base URL |
| `mock` | `MockProvider` | none — offline and deterministic |

`local` and `custom` share the OpenAI-compatible client, which is what most local
servers (Ollama, llama.cpp, LM Studio, vLLM, text-generation-webui) expose.

`mock` is not a stub for the product; it is a deterministic provider used by tests
and available when you want to exercise indexing, retrieval, memory and tools with
no network and no credential.

## Managing providers

```bash
lc providers list                    # configured providers and credential status
lc providers add                     # interactive
lc providers test openai             # authenticate + list models
lc providers enable  openai
lc providers disable openai
lc providers remove  openai
```

`lc providers add` writes a config entry and an `api_key_env` name, then tells you
which environment variable to export. It never asks you to paste a key into a file
it then commits.

## Adding a provider by hand

```json
{
  "id": "together",
  "kind": "custom",
  "label": "Together AI",
  "enabled": true,
  "base_url": "https://api.together.xyz/v1",
  "api_key_env": "TOGETHER_API_KEY",
  "timeout_ms": 120000,
  "headers": { "X-Title": "low-context" },
  "models": [
    { "id": "Qwen/Qwen2.5-Coder-32B-Instruct", "context_limit": 32768, "max_output": 8192 }
  ]
}
```

```bash
export TOGETHER_API_KEY=…
lc providers test together
lc models use Qwen/Qwen2.5-Coder-32B-Instruct
```

## Adding a provider in code

1. Implement `ChatProvider` in `src/providers/<name>.ts`. Reuse
   `src/providers/http.ts` for request plumbing, timeouts, retries and
   error mapping.
2. Map provider errors onto `LowContextError` codes (`PROVIDER_AUTH`,
   `PROVIDER_HTTP`, `PROVIDER_TIMEOUT`, `PROVIDER_UNSUPPORTED`) so the CLI can
   print an actionable message instead of a stack trace.
3. Add a `case` to `createProvider` in `src/providers/registry.ts`.
4. Add the kind to `ProviderKind` in `src/core/config.ts`, plus default models if
   it is generally useful.
5. Add a test using a local HTTP stub — see [testing.md](testing.md).

Nothing above the registry needs to change.

## Failure handling

| Situation | Behaviour |
| --- | --- |
| Missing credential | `PROVIDER_AUTH` with the variable name and the `export` command |
| HTTP 429 / 5xx | Retry with backoff, then fallback model if configured |
| Timeout | `PROVIDER_TIMEOUT`; the request is cancellable |
| Unsupported feature | Downgrade gracefully, note it in the trace |
| Network unreachable | Clear message; suggests the local provider |

Fallback is used **only** when configured (§76):

```json
{
  "active_provider": "openai",
  "active_model": "gpt-4o",
  "fallback_provider": "ollama",
  "fallback_model": "qwen2.5-coder:7b"
}
```

## Rate limits and cost

Providers report token usage when the API returns it; otherwise the estimator is
used and the figure is marked **estimated** in the UI. Cost is computed from the
per-model `input_per_mtok` / `output_per_mtok` in config and is always presented
as an estimate, because pricing changes and cache discounts vary.
