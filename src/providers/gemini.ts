/**
 * Google Gemini provider.
 *
 * Gemini's shape differs meaningfully from ChatGPT: requests carry
 * `systemInstruction`, `contents` with `role: user|model`, function
 * declarations in `tools[].functionDeclarations`, and streamed responses are
 * `generateContent?alt=sse` candidates. Function responses travel back as a
 * `functionResponse` part under role `user`.
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

interface GeminiPart {
  text?: string;
  thought?: boolean;
  functionCall?: { name?: string; args?: Record<string, unknown> };
  functionResponse?: { name?: string; response?: Record<string, unknown> };
}

export class GeminiProvider implements ChatProvider {
  readonly kind = 'gemini';
  private readonly http: ProviderHttp;
  private readonly apiKey: string | undefined;

  constructor(
    readonly name: string,
    options: { baseUrl: string; apiKey?: string; headers?: Record<string, string>; timeoutMs?: number },
  ) {
    this.apiKey = options.apiKey;
    // Key may arrive as a query param; strip an accidental ?key= from baseUrl.
    this.http = new ProviderHttp({
      baseUrl: options.baseUrl.replace(/\?key=.*$/, ''),
      apiKey: options.apiKey,
      headers: options.headers,
      timeoutMs: options.timeoutMs,
    });
  }

  private url(model: string, stream: boolean): string {
    const suffix = stream ? 'streamGenerateContent?alt=sse' : 'generateContent';
    const key = this.apiKey ? `&key=${encodeURIComponent(this.apiKey)}` : '';
    return `/models/${encodeURIComponent(model)}:${suffix}${key}`;
  }

  async *generate(request: GenerationRequest): AsyncIterable<StreamEvent> {
    const { systemInstruction, contents } = mapMessages(request.messages);
    const payload: Record<string, unknown> = {
      contents,
      ...(systemInstruction ? { systemInstruction: { parts: [{ text: systemInstruction }] } } : {}),
      ...(request.tools && request.tools.length > 0
        ? {
            tools: [
              {
                functionDeclarations: request.tools.map((tool) => ({
                  name: tool.name,
                  description: tool.description,
                  parameters: tool.parameters,
                })),
              },
            ],
          }
        : {}),
      ...(request.temperature === undefined ? {} : { generationConfig: { temperature: request.temperature } }),
    };

    const response = await this.http.streamPost(this.url(request.model, true), payload, undefined, request.signal);
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw mapHttpError(response.status, detail);
    }

    let text = '';
    let calls: ToolCall[] = [];
    let usage: UsageReport = { input_tokens: 0, output_tokens: 0, estimated: true };

    for await (const chunk of parseSse(response.body)) {
      const candidates = chunk.candidates as
        | { content?: { parts?: GeminiPart[]; role?: string }; finishReason?: string; thought?: boolean }[]
        | undefined;
      const usageMeta = chunk.usageMetadata as
        | { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number }
        | undefined;
      if (usageMeta) {
        usage = {
          input_tokens: usageMeta.promptTokenCount ?? 0,
          output_tokens: usageMeta.candidatesTokenCount ?? 0,
          estimated: false,
        };
        yield { type: 'usage', usage };
      }
      for (const candidate of candidates ?? []) {
        for (const part of candidate.content?.parts ?? []) {
          if (part.thought) {
            if (part.text) yield { type: 'reasoning', text: part.text };
            continue;
          }
          if (part.functionCall) {
            calls.push({
              id: `gemini_${calls.length}`,
              name: part.functionCall.name ?? '',
              arguments: (part.functionCall.args ?? {}) as Record<string, unknown>,
            });
            continue;
          }
          if (part.text) {
            text += part.text;
            yield { type: 'text', text: part.text };
          }
        }
        if (candidate.finishReason) {
          // finishReason may appear on the chunk carrying the tool call.
          void candidate.finishReason;
        }
      }
    }

    if (calls.length > 0) {
      for (const call of calls) yield { type: 'tool_call', call };
      yield {
        type: 'done',
        stop_reason: 'tool_calls',
        message: {
          role: 'assistant',
          content: text,
          tool_calls: calls.map((c) => ({ id: c.id, name: c.name, arguments: JSON.stringify(c.arguments ?? {}) })),
        },
      };
      return;
    }
    yield { type: 'done', stop_reason: stopReasonOf('stop'), message: { role: 'assistant', content: text } };
  }

  listModels(): Promise<import('../core/types.js').ModelDescriptor[]> {
    return Promise.resolve([]);
  }
}

function mapMessages(messages: readonly ProviderMessage[]): {
  systemInstruction: string | undefined;
  contents: { role: string; parts: GeminiPart[] }[];
} {
  const systemParts: string[] = [];
  const contents: { role: string; parts: GeminiPart[] }[] = [];
  for (const message of messages) {
    if (message.role === 'system') {
      systemParts.push(message.content);
      continue;
    }
    if (message.role === 'assistant') {
      const parts: GeminiPart[] = [];
      if (message.content !== '') parts.push({ text: message.content });
      for (const call of message.tool_calls ?? []) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(call.arguments || '{}') as Record<string, unknown>;
        } catch {
          args = {};
        }
        parts.push({ functionCall: { name: call.name, args } });
      }
      contents.push({ role: 'model', parts });
      continue;
    }
    if (message.role === 'tool') {
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(message.content || '{}') as Record<string, unknown>;
      } catch {
        parsed = { value: message.content };
      }
      contents.push({ role: 'user', parts: [{ functionResponse: { name: message.name ?? '', response: parsed } }] });
      continue;
    }
    contents.push({ role: 'user', parts: message.content === '' ? [] : [{ text: message.content }] });
  }
  // Gemini requires alternating-ish order but tolerates user→user; merge
  // nothing here — the API is lenient and this keeps the trace readable.
  return { systemInstruction: systemParts.length > 0 ? systemParts.join('\n\n') : undefined, contents };
}