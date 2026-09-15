import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { FileIndexStore } from '../src/index/index-store.js';
import { refreshProjectIndex, buildModules } from '../src/index/indexer.js';
import { analyzeSource, detectLanguage } from '../src/index/analysis.js';
import { buildProjectMap, renderProjectMap, renderFileMapEntry } from '../src/index/project-map.js';
import { projectIdForRoot } from '../src/storage/project-store.js';
import { makeProject, tempDir } from './helpers.js';

const TREE: Record<string, string> = {
  'src/auth/service.ts': [
    "import { sign } from './oauth.js';",
    'export interface AuthService {',
    '  login(user: string): Promise<string>;',
    '}',
    'export class Service implements AuthService {',
    '  async login(user: string): Promise<string> {',
    '    return sign(user);',
    '  }',
    '}',
    'export function createService(): Service {',
    '  return new Service();',
    '}',
    '',
  ].join('\n'),
  'src/auth/oauth.ts': [
    'export function sign(user: string): string {',
    '  return `token:${user}`;',
    '}',
    '',
  ].join('\n'),
  'src/payments/receipt.ts': [
    'export function parseReceipt(input: string): number {',
    '  return Number(input.replace(/[^0-9]/g, ""));',
    '}',
    'export function validateReceipt(value: number): boolean {',
    '  return value > 0;',
    '}',
    '',
  ].join('\n'),
  'src/payments/receipt.test.ts': [
    "import { parseReceipt } from './receipt.js';",
    "describe('receipt', () => {",
    "  it('parses a plain amount', () => {",
    '    expect(parseReceipt("$12")).toBe(12);',
    '  });',
    '});',
    '',
  ].join('\n'),
  'README.md': '# Project\n\nA small sample project.\n',
  'node_modules/ignored/index.js': 'module.exports = 1;\n',
  '.gitignore': 'dist\n',
};

test('analysis extracts symbols, imports and tests without noise', () => {
  const analysis = analyzeSource('src/auth/service.ts', TREE['src/auth/service.ts'] as string);
  const names = analysis.symbols.map((symbol) => symbol.name);
  assert.ok(names.includes('AuthService'));
  assert.ok(names.includes('Service'));
  assert.ok(names.includes('createService'));
  // Local variables inside a method are not navigation targets.
  assert.ok(!names.includes('user'));
  assert.ok(!names.includes('sign'));
  assert.equal(analysis.imports[0]?.specifier, './oauth.js');
  assert.equal(analysis.imports[0]?.relative, true);

  const testAnalysis = analyzeSource('src/payments/receipt.test.ts', TREE['src/payments/receipt.test.ts'] as string);
  assert.deepEqual(testAnalysis.tests, ['receipt', 'parses a plain amount']);

  assert.equal(detectLanguage('a/b/c.py'), 'python');
  assert.equal(detectLanguage('a/b/c.unknown'), undefined);
});

test('refreshProjectIndex indexes files, ignores node_modules and builds dependency edges', async () => {
  const root = await makeProject(TREE);
  const dir = await tempDir('lc-idx-');
  const store = new FileIndexStore(dir);
  const projectId = projectIdForRoot(root);

  const result = await refreshProjectIndex({ root, projectId, store, force: true });
  assert.equal(result.added, Object.keys(TREE).length - 1); // node_modules excluded
  assert.ok(result.modules >= 2);

  const service = await store.getFile(projectId, 'src/auth/service.ts');
  assert.ok(service);
  assert.equal(service?.language, 'typescript');
  assert.ok(service?.symbols.includes('createService'));
  assert.deepEqual(service?.depends_on_files, ['src/auth/oauth.ts']);
  assert.equal(service?.verification_state, 'verified');

  const oauth = await store.getFile(projectId, 'src/auth/oauth.ts');
  assert.deepEqual(oauth?.depended_on_by, ['src/auth/service.ts']);

  assert.equal(await store.getFile(projectId, 'node_modules/ignored/index.js'), undefined);
});

test('incremental refresh re-analyses only changed files', async () => {
  const root = await makeProject(TREE);
  const dir = await tempDir('lc-idx-');
  const store = new FileIndexStore(dir);
  const projectId = projectIdForRoot(root);

  await refreshProjectIndex({ root, projectId, store, force: true });
  const second = await refreshProjectIndex({ root, projectId, store });
  assert.equal(second.changed, 0);
  assert.equal(second.added, 0);
  assert.equal(second.unchanged, Object.keys(TREE).length - 1);

  await writeFile(
    join(root, 'src/payments/receipt.ts'),
    'export function parseReceipt(input: string): number {\n  return Number(input.replace(/[^0-9]/g, "")) * 2;\n}\n',
    'utf8',
  );
  const third = await refreshProjectIndex({ root, projectId, store });
  assert.equal(third.changed, 1);
  assert.equal(third.added, 0);

  const updated = await store.getFile(projectId, 'src/payments/receipt.ts');
  assert.ok(updated?.hash);
  // The removed second function is gone from the index — source wins (§37).
  assert.deepEqual(updated?.symbols, ['parseReceipt']);
});

test('a deleted file is dropped from the index', async () => {
  const root = await makeProject(TREE);
  const dir = await tempDir('lc-idx-');
  const store = new FileIndexStore(dir);
  const projectId = projectIdForRoot(root);
  await refreshProjectIndex({ root, projectId, store, force: true });

  const { rm } = await import('node:fs/promises');
  await rm(join(root, 'src/auth/oauth.ts'));
  const result = await refreshProjectIndex({ root, projectId, store });
  assert.equal(result.removed, 1);
  assert.equal(await store.getFile(projectId, 'src/auth/oauth.ts'), undefined);
});

test('symbol and file search find the right definitions', async () => {
  const root = await makeProject(TREE);
  const dir = await tempDir('lc-idx-');
  const store = new FileIndexStore(dir);
  const projectId = projectIdForRoot(root);
  await refreshProjectIndex({ root, projectId, store, force: true });

  const symbols = await store.findSymbol(projectId, 'parseReceipt');
  assert.equal(symbols.length, 1);
  assert.equal(symbols[0]?.file.path, 'src/payments/receipt.ts');

  const files = await store.searchFiles(projectId, 'receipt parsing', 5);
  assert.equal(files[0]?.file.path, 'src/payments/receipt.ts');

  const none = await store.findSymbol(projectId, 'doesNotExist');
  assert.deepEqual(none, []);
});

test('modules group files and project map renders a navigation tree', async () => {
  const root = await makeProject(TREE);
  const dir = await tempDir('lc-idx-');
  const store = new FileIndexStore(dir);
  const projectId = projectIdForRoot(root);
  await refreshProjectIndex({ root, projectId, store, force: true });

  const files = await store.listFiles(projectId);
  const modules = await store.listModules(projectId);
  const authModule = modules.find((module) => module.path === 'src/auth');
  assert.ok(authModule);
  assert.equal(authModule?.file_count, 2);
  assert.ok(authModule?.top_symbols.includes('createService'));

  const map = buildProjectMap(root, files, modules);
  assert.equal(map.total_files, files.length);
  assert.ok(map.total_symbols > 0);
  const rendered = renderProjectMap(map);
  assert.match(rendered, /Project /);
  assert.match(rendered, /src/);

  const entry = renderFileMapEntry(files.find((file) => file.path === 'src/auth/service.ts') as never);
  assert.match(entry, /createService/);
  assert.match(entry, /Depends on: src\/auth\/oauth\.ts/);

  const grouped = buildModules(projectId, files);
  assert.ok(grouped.some((module) => module.path === 'src/payments'));
});

test('markStale downgrades entries whose source changed underneath', async () => {
  const root = await makeProject(TREE);
  const dir = await tempDir('lc-idx-');
  const store = new FileIndexStore(dir);
  const projectId = projectIdForRoot(root);
  await refreshProjectIndex({ root, projectId, store, force: true });

  const marked = await store.markStale(projectId, ['src/auth/oauth.ts']);
  assert.equal(marked, 1);
  const file = await store.getFile(projectId, 'src/auth/oauth.ts');
  assert.equal(file?.stale, true);
  assert.equal(file?.verification_state, 'stale');
});
