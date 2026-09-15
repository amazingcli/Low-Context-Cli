import { ProviderHttp } from './http.js';
import { parseSse, stopReasonOf } from './types.js';
export class OpenAIProvider {
    name;
    kind = 'openai-compatible';
    http;
    constructor(name, options) {
        this.name = name;
        this.http = new ProviderHttp({
            baseUrl: options.baseUrl,
            apiKey: options.apiKey,
            headers: options.headers,
            timeoutMs: options.timeoutMs,
        });
    }
    async *generate(request) {
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
            const data = (await this.http.postJson(endpoint, payload, undefined, request.signal));
            const choice = data.choices?.[0];
            const message = choice?.message ?? { role: 'assistant', content: '' };
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
        let toolCalls = [];
        let contentAccum = '';
        let seenFirst = false;
        let usage;
        for await (const chunk of parseSse(response.body)) {
            if (chunk.id && chunk.object === 'chat.completion.chunk') {
                const choices = chunk.choices;
                const delta = choices?.[0]?.delta;
                if (delta?.reasoning_content)
                    yield { type: 'reasoning', text: delta.reasoning_content };
                if (delta?.content) {
                    contentAccum += delta.content;
                    yield { type: 'text', text: delta.content };
                }
                for (const tc of delta?.tool_calls ?? []) {
                    const idx = tc.index ?? 0;
                    while (toolCalls.length <= idx) {
                        toolCalls.push({ index: toolCalls.length, id: '', name: '', arguments: '' });
                    }
                    const slot = toolCalls[idx];
                    if (tc.id)
                        slot.id = tc.id;
                    if (tc.function?.name)
                        slot.name += tc.function.name;
                    if (tc.function?.arguments)
                        slot.arguments += tc.function.arguments;
                }
            }
            if (chunk.usage) {
                usage = this.usageOf(chunk.usage);
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
            if (call.id === '' || call.name === '')
                continue;
            let args = {};
            try {
                args = JSON.parse(call.arguments || '{}');
            }
            catch {
                args = { _raw: call.arguments };
            }
            yield { type: 'tool_call', call: { id: call.id, name: call.name, arguments: args, raw_arguments: call.arguments } };
        }
        if (contentAccum !== '') {
            yield { type: 'done', stop_reason: 'end_turn', message: { role: 'assistant', content: contentAccum } };
        }
    }
    listModels() {
        // Catalog comes from config; the HTTP `/models` endpoint is advisory.
        return Promise.resolve([]);
    }
    usageOf(raw) {
        if (!raw || typeof raw !== 'object')
            return { input_tokens: 0, output_tokens: 0, estimated: true };
        const details = raw.prompt_tokens_details;
        return {
            input_tokens: numberOrZero(raw.prompt_tokens),
            output_tokens: numberOrZero(raw.completion_tokens),
            cached_input_tokens: details ? numberOrZero(details.cached_tokens) : undefined,
            estimated: false,
        };
    }
}
class ProviderHttpError extends Error {
    status;
    detail;
    constructor(status, detail) {
        super(`HTTP ${status}: ${detail.slice(0, 200)}`);
        this.status = status;
        this.detail = detail;
    }
}
function mapMessages(messages) {
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
function numberOrZero(value) {
    return typeof value === 'number' ? value : 0;
}
/** Re-export for error mapping: OpenAI-compatible non-2xx handling. */
export async function throwForStatus(response) {
    if (response.ok)
        return;
    const text = await response.text().catch(() => '');
    throw new ProviderHttpError(response.status, text);
}
//# sourceMappingURL=openai.js.map