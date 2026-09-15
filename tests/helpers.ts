/**
 * Test helpers.
 *
 * Every test runs against a throwaway `LOW_CONTEXT_HOME` and a throwaway
 * project directory, so a test can never read or corrupt the developer's real
 * memory, index or credentials — which matters because that is the data this
 * suite is mostly about.
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { GenerationRequest, ModelDescriptor, ProviderMessage, StreamEvent, ToolCall } from '../src/core/types.js';
import type { ChatProvider } from '../src/providers/types.js';

export async function tempDir(prefix = 'lc-test-'): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

/** Run `fn` with LOW_CONTEXT_HOME pointed at a scratch directory. */
export async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = await tempDir('lc-home-');
  const previous = process.env.LOW_CONTEXT_HOME;
  process.env.LOW_CONTEXT_HOME = home;
  try {
    return await fn(home);
  } finally {
    if (previous === undefined) delete process.env.LOW_CONTEXT_HOME;
    else process.env.LOW_CONTEXT_HOME = previous;
    await rm(home, { recursive: true, force: true });
  }
}

/** Create a project tree from a `path -> contents` map. */
export async function writeTree(root: string, files: Record<string, string>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, 'utf8');
  }
}

export async function makeProject(files: Record<string, string>): Promise<string> {
  const root = await tempDir('lc-proj-');
  await writeTree(root, files);
  return root;
}

/** A provider that replays a scripted list of turns, one per `generate` call. */
export class ScriptedProvider implements ChatProvider {
  readonly kind = 'scripted';
  readonly calls: GenerationRequest[] = [];

  constructor(
    readonly name: string,
    private readonly turns: StreamEvent[][],
  ) {}

  async *generate(request: GenerationRequest): AsyncIterable<StreamEvent> {
    this.calls.push(request);
    const turn = this.turns[Math.min(this.calls.length - 1, this.turns.length - 1)] ?? [];
    for (const event of turn) yield event;
  }

  async listModels(): Promise<ModelDescriptor[]> {
    return [scriptedModel()];
  }
}

export function scriptedModel(overrides: Partial<ModelDescriptor> = {}): ModelDescriptor {
  return {
    id: 'scripted-1',
    provider: 'scripted',
    label: 'Scripted',
    context_limit: 32_768,
    max_output: 4_096,
    capabilities: {
      streaming: true,
      tool_calling: true,
      embeddings: false,
      vision: false,
      json_mode: true,
      reasoning: false,
      exact_usage: true,
    },
    ...overrides,
  };
}

/** Build a text-only assistant turn. */
export function textTurn(text: string): StreamEvent[] {
  return [
    { type: 'text', text },
    { type: 'usage', usage: { input_tokens: 100, output_tokens: 20, estimated: false } },
    { type: 'done', stop_reason: 'end_turn', message: { role: 'assistant', content: text } },
  ];
}

/**
 * Build a single assistant turn that requests one tool call. The agent calls
 * the provider once per turn, so a script is one array per `generate` call.
 */
export function toolTurn(text: string, call: ToolCall): StreamEvent[] {
  return [
    ...(text === '' ? [] : [{ type: 'text', text } as StreamEvent]),
    { type: 'usage', usage: { input_tokens: 120, output_tokens: 24, estimated: false } },
    { type: 'tool_call', call },
    {
      type: 'done',
      stop_reason: 'tool_calls',
      message: {
        role: 'assistant',
        content: text,
        tool_calls: [{ id: call.id, name: call.name, arguments: JSON.stringify(call.arguments) }],
      },
    },
  ];
}

export function userMessage(content: string): ProviderMessage {
  return { role: 'user', content };
}

export function textOf(messages: readonly ProviderMessage[], role: ProviderMessage['role']): string {
  return messages
    .filter((message) => message.role === role)
    .map((message) => message.content)
    .join('\n');
}

export function newToolCall(name: string, args: Record<string, unknown>): ToolCall {
  return { id: `call_${Math.random().toString(36).slice(2, 10)}`, name, arguments: args };
}
