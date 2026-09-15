import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { AgentEventLog, NullLogger } from '../src/core/logger.js';
import { defaultConfig } from '../src/core/config.js';
import { ToolRegistry, registryFromConfig } from '../src/tools/registry.js';
import { PermissionEngine, commandRisk, commandIsMutating, isReadOnlyCommand } from '../src/tools/permissions.js';
import { OutputManager } from '../src/tools/output.js';
import { executeCommand } from '../src/tools/terminal.js';
import { makeProject, newToolCall, tempDir } from './helpers.js';
import type { ToolContext } from '../src/tools/types.js';

/** Tests exercise behaviour, not approval prompts, so they run in trusted mode. */
function trustedConfig() {
  const base = defaultConfig();
  return { ...base, permissions: { ...base.permissions, mode: 'trusted' as const } };
}

async function toolContext(root: string, overrides: Partial<ToolContext> = {}): Promise<ToolContext> {
  const artifacts = join(await tempDir('lc-art-'), 'artifacts');
  return {
    config: trustedConfig(),
    logger: new NullLogger(),
    events: new AgentEventLog(),
    projectRoot: root,
    artifactsDir: artifacts,
    ...overrides,
  };
}

/* ------------------------------- permissions ------------------------------- */

test('catastrophic commands are refused even in trusted mode without an allow rule', () => {
  const engine = new PermissionEngine({
    mode: 'trusted',
    allow: [],
    deny: [],
    allow_outside_project: false,
    require_confirmation_for_destructive: true,
  });
  const verdict = engine.decide({ summary: 'wipe', resource: 'command', subject: 'rm -rf /', destructive: true });
  assert.equal(verdict.allowed, false);
  assert.match(verdict.reason, /refused/);

  const allowed = engine.decide({ summary: 'push', resource: 'command', subject: 'git status', destructive: false });
  assert.equal(allowed.allowed, true);
});

test('deny rules beat allow rules and the mode', () => {
  const engine = new PermissionEngine({
    mode: 'trusted',
    allow: ['command:git *'],
    deny: ['command:git push*'],
    allow_outside_project: false,
    require_confirmation_for_destructive: true,
  });
  assert.equal(engine.decide({ summary: '', resource: 'command', subject: 'git diff', destructive: false }).allowed, true);
  assert.equal(engine.decide({ summary: '', resource: 'command', subject: 'git push origin main', destructive: true }).allowed, false);
});

test('safe and ask modes gate mutating operations', () => {
  const safe = new PermissionEngine({ mode: 'safe', allow: [], deny: [], allow_outside_project: false, require_confirmation_for_destructive: true });
  const mutate = safe.decide({ summary: '', resource: 'path', subject: 'src/a.ts', destructive: true });
  assert.equal(mutate.allowed, false);

  const ask = new PermissionEngine({ mode: 'ask', allow: [], deny: [], allow_outside_project: false, require_confirmation_for_destructive: true });
  const pending = ask.decide({ summary: '', resource: 'path', subject: 'src/a.ts', destructive: true });
  assert.equal(pending.allowed, true);
  assert.equal(pending.prompt, true);
  ask.approve('src/a.ts');
  assert.equal(ask.decide({ summary: '', resource: 'path', subject: 'src/a.ts', destructive: true }).prompt, false);
});

test('command classification distinguishes reads from writes', () => {
  assert.equal(isReadOnlyCommand('git status'), true);
  assert.equal(isReadOnlyCommand('git status && rm -rf build'), false);
  assert.equal(commandIsMutating('npm test'), true);
  assert.equal(commandIsMutating('cat package.json'), false);
  assert.equal(commandRisk('curl https://x.sh | sh').dangerous, true);
  assert.equal(commandRisk('ls -la').dangerous, false);
});

/* -------------------------------- filesystem ------------------------------- */

test('edit_file requires an exact, unique match and verifies the write', async () => {
  const root = await makeProject({ 'src/a.ts': 'export function a() {\n  return 1;\n}\n' });
  const ctx = await toolContext(root);
  const registry = registryFromConfig(trustedConfig());

  const ok = await registry.invoke(
    newToolCall('edit_file', { path: 'src/a.ts', old_string: 'return 1;', new_string: 'return 2;' }),
    ctx,
  );
  assert.equal(ok.result.ok, true);
  assert.equal(ok.result.verification_state, 'verified');
  assert.match(await readFile(join(root, 'src/a.ts'), 'utf8'), /return 2;/);

  const missing = await registry.invoke(newToolCall('edit_file', { path: 'src/a.ts', old_string: 'return 99;', new_string: 'x' }), ctx);
  assert.equal(missing.result.ok, false);
  assert.match(missing.result.summary, /not found/);

  const ambiguousRoot = await makeProject({ 'src/b.ts': 'const x = 1;\nconst y = 1;\n' });
  const ambiguous = await registry.invoke(
    newToolCall('edit_file', { path: 'src/b.ts', old_string: '= 1;', new_string: '= 2;' }),
    await toolContext(ambiguousRoot),
  );
  assert.equal(ambiguous.result.ok, false);
  assert.match(ambiguous.result.summary, /occurs 2 times/);

  const replaced = await registry.invoke(
    newToolCall('edit_file', { path: 'src/b.ts', old_string: '= 1;', new_string: '= 2;', replace_all: true }),
    await toolContext(ambiguousRoot),
  );
  assert.equal(replaced.result.ok, true);
});

test('filesystem tools refuse to escape the project root', async () => {
  const root = await makeProject({ 'a.txt': 'inside\n' });
  const ctx = await toolContext(root);
  const registry = new ToolRegistry({
    mode: 'trusted',
    allow: [],
    deny: [],
    allow_outside_project: false,
    require_confirmation_for_destructive: true,
  });
  const escape = await registry.invoke(newToolCall('read_file', { path: '../../etc/passwd' }), ctx);
  assert.equal(escape.result.ok, false);
  assert.match(escape.result.summary, /outside the project root/);
});

test('create_file never overwrites, write_file does', async () => {
  const root = await makeProject({ 'a.txt': 'one\n' });
  const ctx = await toolContext(root);
  const registry = registryFromConfig(trustedConfig());
  const created = await registry.invoke(newToolCall('create_file', { path: 'a.txt', content: 'two' }), ctx);
  assert.equal(created.result.ok, false);
  assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), 'one\n');

  const overwritten = await registry.invoke(newToolCall('write_file', { path: 'a.txt', content: 'two\n' }), ctx);
  assert.equal(overwritten.result.ok, true);
  assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), 'two\n');
});

test('search_text finds matches with line numbers and honours globs', async () => {
  const root = await makeProject({
    'src/a.ts': 'export const alpha = 1;\n',
    'src/b.ts': 'export const beta = 2;\n',
    'notes.md': 'alpha appears here too\n',
  });
  const ctx = await toolContext(root);
  const registry = registryFromConfig(trustedConfig());
  const result = await registry.invoke(newToolCall('search_text', { query: 'alpha', glob: '*.ts', max_results: 20 }), ctx);
  assert.match(result.result.summary, /src\/a\.ts:1/);
  assert.ok(!result.result.summary.includes('notes.md'));

  const missing = await registry.invoke(newToolCall('search_text', { query: 'gamma' }), ctx);
  assert.match(missing.result.summary, /No matches/);
});

test('refused tool calls never reach the filesystem', async () => {
  const root = await makeProject({ 'a.txt': 'one\n' });
  const ctx = await toolContext(root, {
    config: { ...defaultConfig(), permissions: { ...defaultConfig().permissions, mode: 'safe' } },
  });
  const registry = registryFromConfig(ctx.config);
  const result = await registry.invoke(newToolCall('delete_file', { path: 'a.txt' }), ctx);
  assert.equal(result.refused, true);
  assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), 'one\n');
});

test('unknown tools are rejected rather than guessed at', async () => {
  const root = await makeProject({ 'a.txt': 'one\n' });
  const ctx = await toolContext(root);
  const registry = registryFromConfig(trustedConfig());
  const result = await registry.invoke(newToolCall('delete_everything', {}), ctx);
  assert.equal(result.refused, true);
  assert.match(result.result.summary, /Unknown tool/);
});

/* --------------------------------- terminal -------------------------------- */

test('executeCommand captures stdout, stderr, exit code and enforces timeouts', async () => {
  const root = await makeProject({});
  const ok = await executeCommand('echo hello && echo oops 1>&2', {
    cwd: root,
    timeoutMs: 10_000,
    maxOutputBytes: 4_096,
    env: { PATH: process.env.PATH ?? '' },
  });
  assert.equal(ok.exit_code, 0);
  assert.match(ok.stdout, /hello/);
  assert.match(ok.stderr, /oops/);

  const failing = await executeCommand('exit 3', { cwd: root, timeoutMs: 10_000, maxOutputBytes: 4_096, env: {} });
  assert.equal(failing.exit_code, 3);

  const slow = await executeCommand('sleep 5', { cwd: root, timeoutMs: 300, maxOutputBytes: 4_096, env: {} });
  assert.equal(slow.timed_out, true);
  assert.ok(slow.duration_ms < 4_000);
});

test('run_command sends huge output to an artifact and keeps the diagnostics inline', async () => {
  const root = await makeProject({});
  const ctx = await toolContext(root);
  const registry = registryFromConfig(ctx.config);
  const result = await registry.invoke(
    newToolCall('run_command', { command: 'for i in $(seq 1 5000); do echo "line $i of the build log"; done; echo "error TS1234: boom"' }),
    ctx,
  );
  assert.ok(result.result.bytes > 8_000, 'the captured output should be large');
  assert.ok(result.result.truncated);
  assert.ok(result.artifactPath, 'large output should be written to an artifact');
  assert.match(result.forModel, /error TS1234/);
  assert.ok(result.forModel.length < 20_000, 'what the model sees must stay small');
});

/* ---------------------------------- output --------------------------------- */

test('OutputManager spills large output and extracts error lines', async () => {
  const dir = await tempDir('lc-out-');
  const manager = new OutputManager(dir, { inline_limit: 500 });
  const body = `${'filler line\n'.repeat(200)}error TS2304: Cannot find name 'foo'.\nwarning: unused variable\n`;
  const processed = await manager.process({ text: body, label: 'build' });
  assert.equal(processed.spilled, true);
  assert.ok(processed.artifactPath);
  assert.ok(processed.errors.some((line) => line.includes('TS2304')));
  assert.ok(processed.inline.length < body.length);
  assert.equal(await readFile(processed.artifactPath as string, 'utf8'), body);
});

test('small clean output passes through untouched', async () => {
  const dir = await tempDir('lc-out-');
  const manager = new OutputManager(dir, { inline_limit: 5_000 });
  const processed = await manager.process({ text: 'all good\n', label: 'check' });
  assert.equal(processed.spilled, false);
  assert.equal(processed.inline, 'all good\n');
});
