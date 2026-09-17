/**
 * OpenAI-compatible provider (also serves local OpenAI-format servers: Ollama,
 * LM Studio, vLLM, LiteLLM, gateways, custom HTTP APIs — §23, §44).
 */
import type {
  GenerationRequest,
  ProviderMessage,
  StreamEvent,
  UsageReport,
} from '../core/types.js';
import type { ChatProvider } from './types.js';
import { ProviderHttp } from './http.js';
import { parseSse, stopReasonOf, guessContextLimit } from './types.js';

export class OpenAIProvider implements ChatProvider {
  readonly kind = 'openai-compatible';
  private readonly http: ProviderHttp;

  constructor(
    readonly name: string,
    options: { baseUrl: string; apiKey?: string; headers?: Record<string, string>; timeoutMs?: number },
  ) {
    this.http = new ProviderHttp({
      baseUrl: options.baseUrl,
      apiKey: options.apiKey,
      headers: options.headers,
      timeoutMs: options.timeoutMs,
    });
  }

  async *generate(request: GenerationRequest): AsyncIterable<StreamEvent> {
    const payload = {
      model: request.model,
      messages: mapMessages(request.messages),
      ...(request.tools && request.tools.length > 0
        ? { tools: request.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })) }
        : {}),
      ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
      ...(request.max_output_tokens === undefined ? {} : { max_tokens: request.max_output_tokens }),
      ...(request.reasoning && request.reasoning.budget_tokens
        ? { reasoning_effort: request.reasoning.effort ?? 'medium' }
        : {}),
      ...(request.stream ? { stream: true, stream_options: { include_usage: true } } : {}),
    };

    const endpoint = request.stream ? '/chat/completions' : '/chat/completions';
    if (!request.stream) {
      const data = (await this.http.postJson(endpoint, payload, undefined, request.signal)) as {
        choices?: { message?: ProviderMessage; finish_reason?: string }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
      };
      const choice = data.choices?.[0];
      const message = choice?.message ?? { role: 'assistant' as const, content: '' };
      yield { type: 'usage', usage: this.usageOf(data.usage) };
      yield {
        type: 'done',
        stop_reason: stopReasonOf(choice?.finish_reason),
        message,
      };
      // If the model produced tool calls, also emit them as events for the UI.
      for (const call of message.tool_calls ?? []) {
        yield { type: 'tool_call', call: { id: call.id, name: call.name, arguments: JSON.parse(call.arguments ?? '{}') } };
      }
      return;
    }

    const response = await this.http.streamPost(endpoint, payload, undefined, request.signal);
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new ProviderHttpError(response.status, detail);
    }

    let toolCalls: { index: number; id: string; name: string; arguments: string }[] = [];
    let contentAccum = '';
    let seenFirst = false;
    let usage: UsageReport | undefined;

    for await (const chunk of parseSse(response.body)) {
      if (chunk.id && chunk.object === 'chat.completion.chunk') {
        const choices = chunk.choices as { index?: number; delta?: { content?: string; tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[]; reasoning_content?: string }; finish_reason?: string }[] | undefined;
        const delta = choices?.[0]?.delta;
        if (delta?.reasoning_content) yield { type: 'reasoning', text: delta.reasoning_content };
        if (delta?.content) {
          contentAccum += delta.content;
          yield { type: 'text', text: delta.content };
        }
        for (const tc of delta?.tool_calls ?? []) {
          const idx = tc.index ?? 0;
          while (toolCalls.length <= idx) {
            toolCalls.push({ index: toolCalls.length, id: '', name: '', arguments: '' });
          }
          const slot = toolCalls[idx] as { index: number; id: string; name: string; arguments: string };
          if (tc.id) slot.id = tc.id;
          if (tc.function?.name) slot.name += tc.function.name;
          if (tc.function?.arguments) slot.arguments += tc.function.arguments;
        }
      }
      if (chunk.usage) {
        usage = this.usageOf(chunk.usage as Record<string, unknown>);
        yield { type: 'usage', usage };
      }
      if (!seenFirst && (contentAccum !== '' || toolCalls.length > 0)) {
        seenFirst = true;
      }
    }

    if (!seenFirst && toolCalls.length === 0) {
      yield { type: 'done', stop_reason: 'end_turn', message: { role: 'assistant', content: contentAccum } };
      return;
    }
    for (const call of toolCalls) {
      if (call.id === '' || call.name === '') continue;
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(call.arguments || '{}') as Record<string, unknown>;
      } catch {
        args = { _raw: call.arguments };
      }
      yield { type: 'tool_call', call: { id: call.id, name: call.name, arguments: args, raw_arguments: call.arguments } };
    }
    if (contentAccum !== '') {
      yield { type: 'done', stop_reason: 'end_turn', message: { role: 'assistant', content: contentAccum } };
    }
  }

  /**
   * Advisory catalogue from `GET /models`. Works for OpenAI and for every
   * OpenAI-compatible server (Ollama, LM Studio, vLLM, gateways), which makes
   * `lc init` able to show the models a key or local server really offers.
   */
  async listModels(): Promise<import('../core/types.js').ModelDescriptor[]> {
    const data = (await this.http.getJson('/models')) as {
      data?: { id?: string; name?: string; context_length?: number }[];
      models?: { id?: string; name?: string; context_length?: number }[];
    };
    const entries = data.data ?? data.models ?? [];
    return entries
      .map((entry) => ({ id: entry.id ?? entry.name, context: entry.context_length }))
      .filter((entry): entry is { id: string; context: number | undefined } => typeof entry.id === 'string' && entry.id !== '')
      .map((entry) => ({
        id: entry.id,
        provider: this.name,
        label: entry.id,
        context_limit: entry.context ?? guessContextLimit(entry.id),
        max_output: 8_192,
        capabilities: {
          streaming: true,
          tool_calling: true,
          embeddings: false,
          vision: true,
          json_mode: true,
          reasoning: /\b(o[1-9]|reason|think|r1)\b/i.test(entry.id),
          exact_usage: true,
        },
      }));
  }

  private usageOf(raw: Record<string, unknown> | undefined): UsageReport {
    if (!raw || typeof raw !== 'object') return { input_tokens: 0, output_tokens: 0, estimated: true };
    const details = raw.prompt_tokens_details as Record<string, unknown> | undefined;
    return {
      input_tokens: numberOrZero(raw.prompt_tokens),
      output_tokens: numberOrZero(raw.completion_tokens),
      cached_input_tokens: details ? numberOrZero(details.cached_tokens) : undefined,
      estimated: false,
    };
  }
}

class ProviderHttpError extends Error {
  constructor(readonly status: number, readonly detail: string) {
    super(`HTTP ${status}: ${detail.slice(0, 200)}`);
  }
}

function mapMessages(messages: readonly ProviderMessage[]): Record<string, unknown>[] {
  return messages.map((message) => {
    switch (message.role) {
      case 'tool':
        return { role: 'tool', tool_call_id: message.tool_call_id, content: message.content };
      case 'assistant':
        return {
          role: 'assistant',
          content: message.content === '' ? null : message.content,
          ...(message.tool_calls && message.tool_calls.length > 0
            ? {
                tool_calls: message.tool_calls.map((call) => ({
                  id: call.id,
                  type: 'function',
                  function: { name: call.name, arguments: call.arguments },
                })),
              }
            : {}),
        };
      default:
        return { role: 'system', content: message.content };
    }
  });
}

function numberOrZero(value: unknown): number {
  return typeof value === 'number' ? value : 0;
}

/** Re-export for error mapping: OpenAI-compatible non-2xx handling. */
export async function throwForStatus(response: Response): Promise<void> {
  if (response.ok) return;
  const text = await response.text().catch(() => '');
  throw new ProviderHttpError(response.status, text);
}