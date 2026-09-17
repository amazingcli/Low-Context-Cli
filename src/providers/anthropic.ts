/**
 * Anthropic Messages provider.
 *
 * Wire differences handled here: `system` is a top-level field, tools use
 * `input_schema`, assistant tool-use content blocks, and the SSE protocol is
 * made of typed events (message_start / content_block_delta / ...).
 */
import type {
  GenerationRequest,
  ProviderMessage,
  StreamEvent,
  ToolCall,
  UsageReport,
} from '../core/types.js';
import type { ChatProvider } from './types.js';
import { ProviderHttp, mapHttpError } from './http.js';
import { parseSse, stopReasonOf } from './types.js';

interface AnthropocContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  thinking?: string;
  signature?: string;
}

export class AnthropicProvider implements ChatProvider {
  readonly kind = 'anthropic';
  private readonly http: ProviderHttp;

  constructor(
    readonly name: string,
    options: { baseUrl: string; apiKey?: string; headers?: Record<string, string>; timeoutMs?: number },
  ) {
    // Anthropic authenticates with `x-api-key`, NOT `Authorization: Bearer`.
    // Passing the key to ProviderHttp would add the Bearer header, and the API
    // rejects it with HTTP 401 — so the key is sent as a header only.
    this.http = new ProviderHttp({
      baseUrl: options.baseUrl,
      headers: {
        'anthropic-version': '2023-06-01',
        ...(options.apiKey ? { 'x-api-key': options.apiKey } : {}),
        ...options.headers,
      },
      timeoutMs: options.timeoutMs,
    });
  }

  async *generate(request: GenerationRequest): AsyncIterable<StreamEvent> {
    const { system, messages } = splitSystem(request.messages);

    const payload: Record<string, unknown> = {
      model: request.model,
      messages: mapMessages(messages),
      max_tokens: request.max_output_tokens ?? 4_096,
      ...(system ? { system } : {}),
      ...(request.tools && request.tools.length > 0 ? { tools: mapTools(request.tools) } : {}),
      ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
      stream: true,
    };

    const response = await this.http.streamPost('/messages', payload, undefined, request.signal);
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw mapHttpError(response.status, detail);
    }

    let text = '';
    let toolBlocks: { id: string; name: string; inputJson: string }[] = [];
    let usage: UsageReport = { input_tokens: 0, output_tokens: 0, estimated: true };
    let stopReason: string | undefined;

    for await (const event of parseSse(response.body)) {
      const type = event.type as string;
      if (type === 'message_start') {
        const m = event.message as { usage?: { input_tokens?: number; output_tokens?: number }; model?: string };
        usage = {
          input_tokens: m?.usage?.input_tokens ?? 0,
          output_tokens: m?.usage?.output_tokens ?? 0,
          estimated: false,
        };
        yield { type: 'usage', usage };
      } else if (type === 'content_block_delta') {
        const delta = event.delta as { type?: string; text?: string; thinking?: string; partial_json?: string };
        if (delta?.type === 'text_delta' && delta.text) {
          text += delta.text;
          yield { type: 'text', text: delta.text };
        } else if (delta?.type === 'thinking_delta' && delta.thinking) {
          yield { type: 'reasoning', text: delta.thinking };
        } else if (delta?.type === 'input_json_delta' && delta.partial_json) {
          const last = toolBlocks[toolBlocks.length - 1];
          if (last) last.inputJson += delta.partial_json;
        }
      } else if (type === 'content_block_start') {
        const block = event.content_block as AnthropocContentBlock | undefined;
        if (block?.type === 'tool_use') {
          toolBlocks.push({ id: block.id ?? '', name: block.name ?? '', inputJson: '' });
        }
      } else if (type === 'message_delta') {
        const delta = event.delta as { stop_reason?: string };
        stopReason = delta?.stop_reason;
        const u = event.usage as { output_tokens?: number };
        if (u && u.output_tokens !== undefined) {
          usage = { ...usage, output_tokens: u.output_tokens };
          yield { type: 'usage', usage };
        }
      } else if (type === 'message_stop') {
        break;
      }
    }

    if (toolBlocks.length > 0) {
      for (const block of toolBlocks) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(block.inputJson || '{}') as Record<string, unknown>;
        } catch {
          args = { _raw: block.inputJson };
        }
        const call: ToolCall = { id: block.id, name: block.name, arguments: args, raw_arguments: block.inputJson };
        yield { type: 'tool_call', call };
      }
      yield {
        type: 'done',
        stop_reason: stopReasonOf('tool_use'),
        message: {
          role: 'assistant',
          content: text,
          tool_calls: toolBlocks.map((b) => ({ id: b.id, name: b.name, arguments: b.inputJson })),
        },
      };
      return;
    }
    yield {
      type: 'done',
      stop_reason: stopReasonOf(stopReason),
      message: { role: 'assistant', content: text },
    };
  }

  /**
   * Advisory catalogue from `GET /v1/models`, used by `lc init` and
   * `lc models list --remote` to show what this key can actually reach.
   * Failures are the caller's to handle: config is the source of truth.
   */
  async listModels(): Promise<import('../core/types.js').ModelDescriptor[]> {
    const data = (await this.http.getJson('/models?limit=100')) as {
      data?: { id?: string; display_name?: string }[];
    };
    return (data.data ?? [])
      .filter((model): model is { id: string; display_name?: string } => typeof model.id === 'string')
      .map((model) => ({
        id: model.id,
        provider: this.name,
        label: model.display_name ?? model.id,
        context_limit: 200_000,
        max_output: 8_192,
        capabilities: {
          streaming: true,
          tool_calling: true,
          embeddings: false,
          vision: true,
          json_mode: true,
          reasoning: true,
          exact_usage: true,
        },
      }));
  }
}

function splitSystem(messages: readonly ProviderMessage[]): { system: string | undefined; messages: ProviderMessage[] } {
  const systemParts: string[] = [];
  const rest: ProviderMessage[] = [];
  for (const message of messages) {
    if (message.role === 'system') systemParts.push(message.content);
    else rest.push(message);
  }
  return { system: systemParts.length > 0 ? systemParts.join('\n\n') : undefined, messages: rest };
}

function mapMessages(messages: readonly ProviderMessage[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const message of messages) {
    switch (message.role) {
      case 'tool': {
        // Tool results are `user` messages with a tool_result content block.
        out.push({
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: message.tool_call_id,
              content: contentText(message.content),
            },
          ],
        });
        break;
      }
      case 'assistant': {
        const blocks: AnthropocContentBlock[] = [];
        if (message.content !== '') blocks.push({ type: 'text', text: message.content });
        for (const call of message.tool_calls ?? []) {
          blocks.push({ type: 'tool_use', id: call.id, name: call.name, input: JSON.parse(call.arguments || '{}') });
        }
        out.push({ role: 'assistant', content: blocks });
        break;
      }
      default:
        out.push({ role: 'user', content: message.content });
    }
  }
  return out;
}

function contentText(content: string): string {
  return content.length > 32_000 ? `${content.slice(0, 32_000)}\n…[truncated]` : content;
}

function mapTools(tools: import('../core/types.js').ProviderToolSpec[]): Record<string, unknown>[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters as Record<string, unknown>,
  }));
}