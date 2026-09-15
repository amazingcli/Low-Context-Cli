/** Simple keyword → response scripts for deterministic tests/usage. */
const SCRIPT = [
    { match: /\b(hello|hi|hey)\b/i, response: 'Hello! I am Low Context (mock provider). What would you like to work on?' },
    {
        match: /\b(action|do|fix|implement|change|create|write|update)\b/i,
        response: 'Here is my plan (mock):\n\n1. Retrieve the relevant files through the project index\n2. Read the target file to verify the current state\n3. Make the change and re-read the edited region\n4. Run related tests\n\nThe mock provider does not make real edits. Configure a real provider with `low-context init` to execute tasks.',
    },
    { match: /\b(summar|explain|what is|how)\b/i, response: 'Summary (mock): based on my retrieval, the relevant context has been loaded. Configure a real provider for a substanceful answer.' },
];
export class MockProvider {
    name;
    kind = 'mock';
    constructor(name = 'mock') {
        this.name = name;
    }
    async *generate(request) {
        const userText = lastUserRequest(request.messages);
        const response = SCRIPT.find((s) => s.match.test(userText))?.response ?? SCRIPT[1]?.response ?? '';
        for (const word of response.split(/(?<= )/)) {
            yield { type: 'text', text: word };
        }
        yield {
            type: 'usage',
            usage: {
                input_tokens: estimateTokens(request.messages.map((m) => m.content).join(' ')),
                output_tokens: estimateTokens(response),
                estimated: true,
            },
        };
        yield { type: 'done', stop_reason: 'end_turn', message: { role: 'assistant', content: response } };
    }
    /** For tests: a variant that emits a tool call when the text mentions one. */
    async *generateWithToolCall(_request, call) {
        yield { type: 'tool_call', call };
        yield {
            type: 'done',
            stop_reason: 'tool_calls',
            message: { role: 'assistant', content: '', tool_calls: [{ id: call.id, name: call.name, arguments: JSON.stringify(call.arguments) }] },
        };
    }
    async listModels() {
        return [
            {
                id: 'mock-1',
                provider: this.name,
                label: 'Mock 1 (offline test model)',
                context_limit: 32_768,
                max_output: 4_096,
                capabilities: { streaming: true, tool_calling: true, embeddings: false, vision: false, json_mode: false, reasoning: false, exact_usage: false },
            },
        ];
    }
}
/**
 * The agent prepends a retrieved-context message and appends verification
 * notes; neither is what the user actually asked. Matching the script against
 * them produced nonsense answers, so the last real request is used.
 */
function lastUserRequest(messages) {
    const requests = messages.filter((message) => message.role === 'user' &&
        !message.content.startsWith('Retrieved working context') &&
        !message.content.startsWith('[verification]'));
    const last = requests[requests.length - 1];
    return last?.content ?? '';
}
function estimateTokens(text) {
    const cjk = (text.match(/[\u3000-\u9fff\u3040-\u30ff]/g) ?? []).length;
    return Math.ceil(cjk * 1.5 + (text.length - cjk) / 4);
}
//# sourceMappingURL=mock.js.map