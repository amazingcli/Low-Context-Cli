import { ProviderHttp, mapHttpError } from './http.js';
import { parseSse, stopReasonOf, guessContextLimit } from './types.js';
export class GeminiProvider {
    name;
    kind = 'gemini';
    http;
    constructor(name, options) {
        this.name = name;
        // Key may arrive as a query param; strip an accidental ?key= from baseUrl.
        //
        // Auth is sent as the `x-goog-api-key` header ONLY. Passing the key to
        // ProviderHttp would add `Authorization: Bearer …`, and Google rejects any
        // Bearer token that is not an OAuth2 access token with HTTP 401
        // "Expected OAuth 2 access token" — even when ?key= is also present. The
        // header also keeps the key out of URLs (and therefore out of logs).
        this.http = new ProviderHttp({
            baseUrl: options.baseUrl.replace(/\?key=.*$/, ''),
            headers: {
                ...(options.apiKey ? { 'x-goog-api-key': options.apiKey } : {}),
                ...options.headers,
            },
            timeoutMs: options.timeoutMs,
        });
    }
    url(model, stream) {
        const suffix = stream ? 'streamGenerateContent?alt=sse' : 'generateContent';
        return `/models/${encodeURIComponent(model)}:${suffix}`;
    }
    async *generate(request) {
        const { systemInstruction, contents } = mapMessages(request.messages);
        const payload = {
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
        let calls = [];
        let usage = { input_tokens: 0, output_tokens: 0, estimated: true };
        for await (const chunk of parseSse(response.body)) {
            const candidates = chunk.candidates;
            const usageMeta = chunk.usageMetadata;
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
                        if (part.text)
                            yield { type: 'reasoning', text: part.text };
                        continue;
                    }
                    if (part.functionCall) {
                        calls.push({
                            id: `gemini_${calls.length}`,
                            name: part.functionCall.name ?? '',
                            arguments: (part.functionCall.args ?? {}),
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
            for (const call of calls)
                yield { type: 'tool_call', call };
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
    /** Advisory catalogue from `GET /models`, used by the setup wizard. */
    async listModels() {
        const data = (await this.http.getJson('/models?pageSize=200'));
        return (data.models ?? [])
            .filter((model) => typeof model.name === 'string')
            .map((model) => {
            const id = model.name.replace(/^models\//, '');
            return {
                id,
                provider: this.name,
                label: model.displayName ?? id,
                context_limit: model.inputTokenLimit ?? guessContextLimit(id),
                max_output: model.outputTokenLimit ?? 8_192,
                capabilities: {
                    streaming: true,
                    tool_calling: (model.supportedGenerationMethods ?? []).includes('generateContent'),
                    embeddings: false,
                    vision: true,
                    json_mode: true,
                    reasoning: /thinking|pro/i.test(id),
                    exact_usage: true,
                },
            };
        });
    }
}
function mapMessages(messages) {
    const systemParts = [];
    const contents = [];
    for (const message of messages) {
        if (message.role === 'system') {
            systemParts.push(message.content);
            continue;
        }
        if (message.role === 'assistant') {
            const parts = [];
            if (message.content !== '')
                parts.push({ text: message.content });
            for (const call of message.tool_calls ?? []) {
                let args = {};
                try {
                    args = JSON.parse(call.arguments || '{}');
                }
                catch {
                    args = {};
                }
                parts.push({ functionCall: { name: call.name, args } });
            }
            contents.push({ role: 'model', parts });
            continue;
        }
        if (message.role === 'tool') {
            let parsed = {};
            try {
                parsed = JSON.parse(message.content || '{}');
            }
            catch {
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
//# sourceMappingURL=gemini.js.map