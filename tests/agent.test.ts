import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { Agent } from '../src/agent/loop.js';
import { openWorkspace } from '../src/agent/workspace.js';
import { AgentEventLog, NullLogger } from '../src/core/logger.js';
import { defaultConfig } from '../src/core/config.js';
import { registryFromConfig } from '../src/tools/registry.js';
import { ScriptedProvider, makeProject, newToolCall, textTurn, textOf, toolTurn, withTempHome } from './helpers.js';
import type { AgentUi } from '../src/agent/loop.js';
import type { LowContextConfig } from '../src/core/config.js';
import type { PermissionRequest } from '../src/tools/types.js';

const PROJECT = {
  'src/payments/receipt.ts': 'export function parseReceipt(input: string): number {\n  return Number(input);\n}\n',
  'src/auth/service.ts': 'export function login(): void {}\n',
  'README.md': '# Sample\n',
};

function testConfig(overrides: Partial<LowContextConfig> = {}): LowContextConfig {
  const base = defaultConfig();
  return {
    ...base,
    permissions: { ...base.permissions, mode: 'trusted' },
    index: { ...base.index, refresh_on_start: false },
    ...overrides,
  };
}

function silentUi(overrides: Partial<AgentUi> = {}): AgentUi {
  return { text: () => undefined, ...overrides };
}

async function harness(options: { turns: Parameters<typeof textTurn> extends never ? never : ReturnType<typeof textTurn>[]; config?: LowContextConfig; project?: Record<string, string> } ) {
  const root = await makeProject(options.project ?? PROJECT);
  const config = options.config ?? testConfig();
  const workspace = await openWorkspace({ root, config, refreshIndex: true });
  const provider = new ScriptedProvider('scripted', options.turns);
  const events = new AgentEventLog();
  return { root, config, workspace, provider, events };
}

test('a turn retrieves verified source into context and records it on disk', async () => {
  await withTempHome(async () => {
    const { workspace, provider, events } = await harness({
      turns: [textTurn('The receipt parser normalises the input before parsing.')],
      project: PROJECT,
    });

    const agent = new Agent({
      workspace,
      provider,
      model: (await provider.listModels())[0] as never,
      registry: registryFromConfig(workspace.config),
      logger: new NullLogger(),
      events,
      ui: silentUi(),
    });

    const result = await agent.run('how does parseReceipt work?');
    assert.match(result.text, /receipt parser/);

    // The model was given the real file content, not just a file name.
    const userContext = textOf(provider.calls[0]?.messages ?? [], 'user');
    assert.match(userContext, /Retrieved working context/);
    assert.match(userContext, /function parseReceipt/);
    assert.match(userContext, /BEGIN UNTRUSTED/);

    // The request and the answer are persisted for later retrieval.
    assert.ok(result.toolCalls === 0);
    assert.ok(events.all().some((event) => event.kind === 'retrieval'));
    const conversations = await workspace.stores.conversations.list({ project_id: workspace.project.id });
    assert.equal(conversations.length, 1);
    const messages = await workspace.stores.conversations.messages((conversations[0] as never as { id: string }).id);
    assert.equal(messages.length, 2);
    assert.equal(messages[0]?.role, 'user');
    assert.equal(messages[1]?.role, 'assistant');
    await workspace.flush();
  });
});

test('a tool call is executed, observed, verified and turned into memory', async () => {
  await withTempHome(async () => {
    const { root, workspace, provider, events } = await harness({
      turns: [
        toolTurn('I will apply the fix.', newToolCall('edit_file', { path: 'src/payments/receipt.ts', old_string: 'return Number(input);', new_string: 'return Number(input.trim());' })),
        textTurn('Updated the parser to trim whitespace before conversion.'),
      ],
      config: testConfig({ verification: { enabled: true, command: 'node -e "process.exit(0)"', paths: [] } }),
    });

    const seen: string[] = [];
    const agent = new Agent({
      workspace,
      provider,
      model: (await provider.listModels())[0] as never,
      registry: registryFromConfig(workspace.config),
      logger: new NullLogger(),
      events,
      ui: silentUi({ verification: (report) => seen.push(report.summary) }),
    });

    const result = await agent.run('trim whitespace in parseReceipt');
    assert.equal(result.toolCalls, 1);
    assert.equal(result.turns, 2);
    assert.match(await readFile(join(root, 'src/payments/receipt.ts'), 'utf8'), /input\.trim\(\)/);

    // Verification ran, saw a real exit code, and only then claimed success.
    assert.ok(result.verification);
    assert.equal(result.verification?.passed, true);
    assert.equal(result.verification?.state, 'verified');
    assert.equal(result.verification?.command?.exit_code, 0);
    assert.ok(seen.length > 0);

    // The second request carries the tool result and the verification block.
    const secondCall = textOf(provider.calls[1]?.messages ?? [], 'tool');
    assert.match(secondCall, /src\/payments\/receipt\.ts/);
    assert.match(secondCall, /Replaced 1 occurrence/);
    const secondUser = textOf(provider.calls[1]?.messages ?? [], 'user');
    assert.match(secondUser, /verification/i);

    // Memory is written from the verified event, not from the model's prose.
    assert.ok(result.memoryWritten >= 1);
    const records = await workspace.stores.memory.list({ project_id: workspace.project.id });
    assert.ok(records.some((record) => record.type === 'COMMAND_RESULT' && record.confidence === 'verified'));
    await workspace.flush();
  });
});

test('a failing verification is reported as unverified, not as success', async () => {
  await withTempHome(async () => {
    const { workspace, provider } = await harness({
      turns: [
        toolTurn('', newToolCall('write_file', { path: 'src/new.ts', content: 'export const x = 1;\n' })),
        textTurn('Added the file.'),
      ],
      config: testConfig({ verification: { enabled: true, command: 'node -e "process.exit(1)"', paths: [] } }),
    });

    const events = new AgentEventLog();
    const agent = new Agent({
      workspace,
      provider,
      model: (await provider.listModels())[0] as never,
      registry: registryFromConfig(workspace.config),
      logger: new NullLogger(),
      events,
      ui: silentUi(),
    });

    const result = await agent.run('add a file');
    assert.equal(result.verification?.passed, false);
    assert.equal(result.verification?.state, 'stale');
    assert.ok(events.all().some((event) => event.kind === 'verification' && event.data?.passed === false));
    await workspace.flush();
  });
});

test('tools are refused in safe mode and the model is told why', async () => {
  await withTempHome(async () => {
    const { root, workspace, provider } = await harness({
      turns: [
        toolTurn('', newToolCall('delete_file', { path: 'README.md' })),
        textTurn('I could not delete the file because the permission policy refused it.'),
      ],
      config: testConfig({ permissions: { ...testConfig().permissions, mode: 'safe' } }),
    });

    const results: string[] = [];
    const agent = new Agent({
      workspace,
      provider,
      model: (await provider.listModels())[0] as never,
      registry: registryFromConfig(workspace.config),
      logger: new NullLogger(),
      events: new AgentEventLog(),
      ui: silentUi({ toolResult: (result) => results.push(result.summary) }),
    });

    const result = await agent.run('delete the readme');
    assert.match(result.text, /refused|could not/i);
    assert.ok(results.some((summary) => /Refused|Not approved/.test(summary)));
    assert.equal(await readFile(join(root, 'README.md'), 'utf8'), '# Sample\n');

    // The refusal is visible to the model as a tool result.
    const toolMessages = textOf(provider.calls[1]?.messages ?? [], 'tool');
    assert.match(toolMessages, /Refused|safe mode/);
    await workspace.flush();
  });
});

test('confirmations are requested in ask mode and a decline is respected', async () => {
  await withTempHome(async () => {
    const prompts: PermissionRequest[] = [];
    const { root, workspace, provider } = await harness({
      turns: [
        toolTurn('', newToolCall('write_file', { path: 'src/added.ts', content: 'export const added = true;\n' })),
        textTurn('The write was declined.'),
      ],
      config: testConfig({ permissions: { ...testConfig().permissions, mode: 'ask' } }),
    });

    const agent = new Agent({
      workspace,
      provider,
      model: (await provider.listModels())[0] as never,
      registry: registryFromConfig(workspace.config),
      logger: new NullLogger(),
      events: new AgentEventLog(),
      ui: silentUi({
        confirm: async (request) => {
          prompts.push(request);
          return false;
        },
      }),
    });

    await agent.run('add a file');
    assert.equal(prompts.length, 1);
    assert.equal(prompts[0]?.resource, 'path');
    assert.match(prompts[0]?.summary ?? '', /src\/added\.ts/);
    await assert.rejects(readFile(join(root, 'src/added.ts'), 'utf8'));
    await workspace.flush();
  });
});

test('an explicit "remember this" is stored without calling the model', async () => {
  await withTempHome(async () => {
    const { workspace, provider } = await harness({ turns: [textTurn('should not be used')] });
    const agent = new Agent({
      workspace,
      provider,
      model: (await provider.listModels())[0] as never,
      registry: registryFromConfig(workspace.config),
      logger: new NullLogger(),
      events: new AgentEventLog(),
      ui: silentUi(),
    });

    const result = await agent.run('remember this: the staging database is read-only');
    assert.equal(provider.calls.length, 0, 'the model must not be called for a pure memory write');
    assert.equal(result.memoryWritten, 0);
    const records = await workspace.stores.memory.list({ project_id: workspace.project.id });
    assert.equal(records.length, 1);
    assert.match(records[0]?.summary ?? '', /staging database is read-only/);
    assert.equal(records[0]?.type, 'USER_INSTRUCTION');
    await workspace.flush();
  });
});

test('dryRun builds the same context without calling the model', async () => {
  await withTempHome(async () => {
    const { workspace, provider } = await harness({ turns: [textTurn('unused')] });
    const agent = new Agent({
      workspace,
      provider,
      model: (await provider.listModels())[0] as never,
      registry: registryFromConfig(workspace.config),
      logger: new NullLogger(),
      events: new AgentEventLog(),
      ui: silentUi(),
    });

    const dry = await agent.dryRun('how does parseReceipt work?');
    assert.equal(provider.calls.length, 0);
    assert.match(dry.report, /Context Budget/);
    assert.match(dry.contextBlock, /function parseReceipt/);
    assert.ok(dry.trace);
    await workspace.flush();
  });
});

test('context is capped for a model with a small window', async () => {
  await withTempHome(async () => {
    const big = { 'src/big.ts': `export const big = 1;\n${'// padding line for the budget test\n'.repeat(4_000)}` };
    const { workspace, provider } = await harness({
      turns: [textTurn('ok')],
      project: big,
      config: testConfig({ context: { ...testConfig().context, strategy: 'minimal' } }),
    });
    const agent = new Agent({
      workspace,
      provider,
      model: { ...(await provider.listModels())[0], context_limit: 4_000 } as never,
      registry: registryFromConfig(workspace.config),
      logger: new NullLogger(),
      events: new AgentEventLog(),
      ui: silentUi(),
    });
    const result = await agent.run('what is in big.ts?');
    assert.ok(result.contextReport);
    assert.ok((result.contextReport?.used_tokens ?? 0) <= (result.contextReport?.usable_tokens ?? 0));
    await workspace.flush();
  });
});
