/**
 * Low Context benchmarks (§70).
 *
 * Measures the things the architecture actually promises:
 *
 *   indexing latency        small / medium / large / very large repositories
 *   incremental indexing    cost of one edited file
 *   retrieval latency       per query, plus the token size of what it produces
 *   memory search latency   over a growing memory store
 *   compaction latency      long conversation -> summary
 *   large output handling   spill + error extraction over megabytes
 *
 * Every number here comes from the real subsystems: the real scanner, the real
 * BM25 index, the real stores. Nothing is mocked or faked (§86).
 *
 * Run with:  npm run bench
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { openWorkspace } from '../src/agent/workspace.js';
import { defaultConfig } from '../src/core/config.js';
import { runRetrieval } from '../src/retrieval/engine.js';
import { compactMessages } from '../src/context/compactor.js';
import { estimateTokens } from '../src/context/estimator.js';
import { OutputManager } from '../src/tools/output.js';
import { candidatesFromUserMessage } from '../src/memory/engine.js';
import { nowIso } from '../src/core/util.js';
import type { ChatMessage, MemoryType, MemoryScope } from '../src/core/types.js';

/* --------------------------------- harness -------------------------------- */

interface Metric {
  bench: string;
  metric: string;
  value: number;
  unit: string;
  note?: string;
}

const metrics: Metric[] = [];

function record(bench: string, metric: string, value: number, unit: string, note?: string): void {
  metrics.push({ bench, metric, value, unit, note });
}

async function time<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const started = performance.now();
  const value = await fn();
  return { value, ms: performance.now() - started };
}

const results: { name: string; passed: boolean; detail: string }[] = [];
function check(name: string, passed: boolean, detail: string): void {
  results.push({ name, passed, detail });
}

/* ------------------------------ synthetic repos ---------------------------- */

/**
 * Generate a repository of `fileCount` files spread over nested modules. The
 * content is realistic enough for the analyser: imports, exported functions and
 * classes, so symbol extraction and the dependency graph have real work to do.
 */
async function makeRepo(root: string, fileCount: number, filesPerModule = 12): Promise<string[]> {
  const paths: string[] = [];
  for (let i = 0; i < fileCount; i += 1) {
    const moduleIndex = Math.floor(i / filesPerModule);
    const domain = ['auth', 'payments', 'receipts', 'orders', 'users', 'search', 'storage'][moduleIndex % 7];
    const path = join('src', domain, `module_${moduleIndex}`, `file_${i}.ts`);
    const relative = join('..', `module_${Math.max(0, moduleIndex - 1)}`, `file_${Math.max(0, i - 1)}.js`);
    const lines = [
      `import { handler_${Math.max(0, i - 1)} } from '${relative.replace(/\\/g, '/')}';`,
      `import { describe } from 'node:test';`,
      '',
      `export interface Record_${i} { id: string; amount: number; createdAt: string }`,
      '',
      `export function parseRecord_${i}(raw: string): Record_${i} {`,
      `  const parts = raw.split(',');`,
      `  return { id: parts[0], amount: Number(parts[1]), createdAt: parts[2] };`,
      `}`,
      '',
      `export class Service_${i} {`,
      `  private cache = new Map<string, Record_${i}>();`,
      `  async load(id: string): Promise<Record_${i} | undefined> {`,
      `    if (this.cache.has(id)) return this.cache.get(id);`,
      `    const row = await this.query(id);`,
      `    if (row) this.cache.set(id, row);`,
      `    return row;`,
      `  }`,
      `  private async query(id: string): Promise<Record_${i} | undefined> {`,
      `    return undefined;`,
      `  }`,
      `}`,
      '',
      `export function handler_${i}(input: string): string {`,
      `  return parseRecord_${i}(input).id;`,
      `}`,
    ];
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, lines.join('\n'), 'utf8');
    paths.push(path);
  }
  return paths;
}

/* ------------------------------ benchmark parts ---------------------------- */

async function benchIndexing(home: string): Promise<void> {
  const sizes: { label: string; files: number }[] = [
    { label: 'small', files: 50 },
    { label: 'medium', files: 500 },
    { label: 'large', files: 2_000 },
    { label: 'very_large', files: 10_000 },
  ];

  console.log('\n## Indexing');
  console.log('   repo        files   cold (ms)   files/s   warm (ms)   incremental (ms)');

  for (const size of sizes) {
    const root = join(home, `repo-${size.label}`);
    await makeRepo(root, size.files);

    const config = defaultConfig();
    config.storage.project_local = true;
    const workspace = await openWorkspace({ root, config, refreshIndex: false });

    const cold = await time(() => workspace.ensureIndex({ force: true }));
    const warm = await time(() => workspace.ensureIndex());

    // One file changes: incremental indexing must not re-read the rest (§5).
    const edited = join(root, 'src', 'auth', 'module_0', 'file_0.ts');
    await writeFile(edited, 'export function edited_0(): number { return 1; }\n', 'utf8');
    const incremental = await time(() => workspace.ensureIndex());

    const summary = await workspace.indexSummary();
    const changed = incremental.value?.changed ?? 0;

    console.log(
      `   ${size.label.padEnd(11)} ${String(size.files).padStart(5)}   ` +
        `${cold.ms.toFixed(0).padStart(9)}   ${(size.files / (cold.ms / 1000)).toFixed(0).padStart(7)}   ` +
        `${warm.ms.toFixed(0).padStart(9)}   ${incremental.ms.toFixed(0).padStart(16)}`,
    );

    record('indexing', `cold_index_${size.label}`, cold.ms, 'ms', `${size.files} files`);
    record('indexing', `cold_throughput_${size.label}`, size.files / (cold.ms / 1000), 'files/s');
    record('indexing', `warm_noop_${size.label}`, warm.ms, 'ms');
    record('indexing', `incremental_${size.label}`, incremental.ms, 'ms', `${changed} file(s) re-analysed`);

    check(
      `incremental indexing touches one file (${size.label})`,
      changed <= 1,
      `${changed} file(s) re-analysed after a single edit`,
    );
    check(
      `incremental is faster than cold (${size.label})`,
      incremental.ms <= cold.ms,
      `${incremental.ms.toFixed(0)}ms vs ${cold.ms.toFixed(0)}ms cold`,
    );
    check(`index summary present (${size.label})`, (summary?.files ?? 0) === size.files, `${summary?.files ?? 0} files indexed`);

    await workspace.flush();
  }
}

async function benchRetrieval(home: string): Promise<void> {
  console.log('\n## Retrieval');
  console.log('   query                              ms      candidates   kept   context tokens');

  const root = join(home, 'retrieval-repo');
  const fileCount = 1_500;
  await makeRepo(root, fileCount);

  const config = defaultConfig();
  config.storage.project_local = true;
  const workspace = await openWorkspace({ root, config });
  // `ensureIndex()` only refreshes when asked: indexing is opt-in per call so
  // that read-only commands never pay for a scan (§5).
  await workspace.ensureIndex({ force: true });

  // Seed memory so retrieval has more than code to choose from.
  for (let i = 0; i < 300; i += 1) {
    await workspace.stores.memory.write({
      type: (i % 2 === 0 ? 'DECISION' : 'BUG') as MemoryType,
      scope: 'project' as MemoryScope,
      summary: `Decision ${i}: receipts module ${i % 3 === 0 ? 'validates amounts' : 'groups line items'} at ${i}`,
      project_id: workspace.project.id,
      confidence: 'high',
      importance: i % 10 === 0 ? 'important' : 'normal',
    });
  }

  const queries = [
    'why is the payment receipt parser slow',
    'where is the auth handler timeout configured',
    'parseRecord_412',
    'receipt validation decision',
    'change the receipts module to validate amounts',
  ];

  for (const query of queries) {
    const run = await time(() =>
      runRetrieval(
        {
          config,
          indexStore: workspace.stores.index,
          memoryStore: workspace.stores.memory,
          conversationStore: workspace.stores.conversations,
          projectRoot: root,
          projectId: workspace.project.id,
        },
        { query, limit: 12 },
      ),
    );

    const tokens = run.value.candidates.reduce(
      (sum, candidate) => sum + estimateTokens(candidate.content ?? candidate.excerpt ?? candidate.reason).tokens,
      0,
    );
    console.log(
      `   ${query.slice(0, 33).padEnd(34)} ${run.ms.toFixed(0).padStart(5)}   ` +
        `${String(run.value.candidates.length).padStart(10)}   ${String(run.value.verifiedFiles.length).padStart(4)}   ${String(tokens).padStart(14)}`,
    );

    record('retrieval', `query_latency`, run.ms, 'ms', query);
    record('retrieval', `context_tokens`, tokens, 'tokens', query);

    check(`retrieval returns candidates for "${query}"`, run.value.candidates.length > 0, `${run.value.candidates.length} candidates`);
    check(`retrieval context stays small for "${query}"`, tokens < 20_000, `${tokens} tokens`);
  }

  await workspace.flush();
  void fileCount;
}

async function benchMemory(home: string): Promise<void> {
  console.log('\n## Memory');
  console.log('   records    write (ms)    search (ms)    search p95 (ms)');

  const root = join(home, 'memory-repo');
  await mkdir(root, { recursive: true });
  const config = defaultConfig();
  config.storage.project_local = true;
  const workspace = await openWorkspace({ root, config, refreshIndex: false });

  const targets = [100, 1_000, 10_000, 50_000];
  let written = 0;

  for (const target of targets) {
    const writeStarted = performance.now();
    const batch: Promise<unknown>[] = [];
    for (let i = written; i < target; i += 1) {
      batch.push(
        workspace.stores.memory.write({
          type: (['FACT', 'DECISION', 'BUG', 'FIX', 'PROJECT_KNOWLEDGE'] as MemoryType[])[i % 5],
          scope: (['global', 'project', 'module', 'session', 'task'] as MemoryScope[])[i % 5],
          summary: `Record ${i}: ${i % 7 === 0 ? 'authentication provider' : 'payment receipt'} detail number ${i}`,
          detail: `Detail body ${i}. The ${i % 7 === 0 ? 'auth' : 'payments'} subsystem changed in step ${i}.`,
          project_id: workspace.project.id,
          confidence: 'high',
          importance: i % 25 === 0 ? 'important' : 'normal',
          source_refs: [{ kind: 'message', conversation_id: 'conv_bench', message_id: `msg_${i}` }],
        }),
      );
    }
    await Promise.all(batch);
    const writeMs = performance.now() - writeStarted;
    written = target;

    const samples: number[] = [];
    for (let i = 0; i < 30; i += 1) {
      const started = performance.now();
      await workspace.stores.memory.search({ text: `authentication provider ${i}`, project_id: workspace.project.id, limit: 10 });
      samples.push(performance.now() - started);
    }
    samples.sort((a, b) => a - b);
    const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
    const p95 = samples[Math.floor(samples.length * 0.95)] ?? samples[samples.length - 1];

    console.log(
      `   ${String(target).padStart(7)}   ${writeMs.toFixed(0).padStart(10)}   ${avg.toFixed(2).padStart(11)}   ${p95.toFixed(2).padStart(14)}`,
    );

    record('memory', 'write_batch', writeMs, 'ms', `${target - (targets[targets.indexOf(target) - 1] ?? 0)} new records`);
    record('memory', 'search_avg', avg, 'ms', `${target} records`);
    record('memory', 'search_p95', p95, 'ms', `${target} records`);

    check(`memory search under 250ms at ${target} records`, p95 < 250, `p95 ${p95.toFixed(2)}ms`);
  }

  const recordCount = await workspace.stores.memory.count({ project_id: workspace.project.id });
  check('memory store reports records', recordCount >= 50_000, `${recordCount} records on disk`);
  await workspace.flush();
}

async function benchContext(home: string): Promise<void> {
  console.log('\n## Context');

  const root = join(home, 'context-repo');
  await mkdir(root, { recursive: true });
  const config = defaultConfig();
  config.storage.project_local = true;
  const workspace = await openWorkspace({ root, config, refreshIndex: false });

  // A long conversation: 2,000 messages.
  const conversation = await workspace.stores.conversations.create({ project_id: workspace.project.id });
  const history: ChatMessage[] = [];
  for (let i = 0; i < 2_000; i += 1) {
    history.push({
      id: `msg_${i}`,
      conversation_id: conversation.id,
      timestamp: nowIso(),
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `Message ${i}: ${i % 3 === 0 ? 'we decided to use PostgreSQL for the receipts table' : 'working on the auth timeout bug in service.ts'}`,
      importance: i % 50 === 0 ? 'important' : 'normal',
    });
  }

  const fullTokens = history.reduce((sum, message) => sum + estimateTokens(message.content).tokens, 0);
  const compact = await time(() =>
    compactMessages({
      messages: history,
      conversationId: conversation.id,
      conversationStore: workspace.stores.conversations,
      memoryStore: workspace.stores.memory,
      projectId: workspace.project.id,
    }),
  );

  const summaryTokens = estimateTokens(compact.value.summary).tokens;
  const ratio = summaryTokens === 0 ? 0 : fullTokens / summaryTokens;

  console.log(`   2,000 messages                   ${fullTokens.toLocaleString()} tokens`);
  console.log(`   compaction                       ${compact.ms.toFixed(0)} ms`);
  console.log(`   summary                          ${summaryTokens.toLocaleString()} tokens (${ratio.toFixed(1)}x smaller)`);

  record('context', 'raw_conversation_tokens', fullTokens, 'tokens', '2,000 messages');
  record('context', 'compaction_latency', compact.ms, 'ms', '2,000 messages');
  record('context', 'compaction_ratio', ratio, 'x', 'raw / summary tokens');

  check('compaction produces a smaller summary', ratio > 5, `${ratio.toFixed(1)}x reduction`);
  const decisionsKept = compact.value.memoryRecords.filter((record) => record.type === 'DECISION').length;
  check('compaction preserves decisions', decisionsKept > 0, `${decisionsKept} decisions kept`);

  // Memory extraction from a user message.
  const extraction = await time(async () =>
    candidatesFromUserMessage('Remember: the receipts API uses PostgreSQL and validates amounts in cents.', {
      projectId: workspace.project.id,
    }),
  );
  record('context', 'memory_extraction_latency', extraction.ms, 'ms');
  check('memory extraction yields candidates', extraction.value.length > 0, `${extraction.value.length} candidate(s)`);

  await workspace.flush();
}

async function benchLargeOutput(home: string): Promise<void> {
  console.log('\n## Large tool output');

  const artifacts = join(home, 'artifacts');
  await mkdir(artifacts, { recursive: true });
  const store = new OutputManager(artifacts);

  // ~10 MB of build log with a handful of real errors buried in it.
  const lines: string[] = [];
  for (let i = 0; i < 200_000; i += 1) {
    if (i % 20_000 === 0) lines.push(`src/file_${i}.ts(${i},3): error TS2304: Cannot find name 'value_${i}'.`);
    else lines.push(`[build] compiling module ${i} ... ok in ${i % 97}ms`);
  }
  const huge = lines.join('\n');
  const bytes = Buffer.byteLength(huge, 'utf8');

  const processed = await time(async () => store.process({ text: huge, label: 'build log' }));
  const inlineTokens = estimateTokens(processed.value.inline).tokens;

  console.log(`   input                            ${(bytes / 1_048_576).toFixed(1)} MB`);
  console.log(`   processing                       ${processed.ms.toFixed(0)} ms`);
  console.log(`   inline context                   ${inlineTokens.toLocaleString()} tokens (${(processed.value.inline.length / bytes * 100).toFixed(2)}% of input)`);
  console.log(`   errors extracted                 ${processed.value.errors.length}`);

  record('output', 'process_latency', processed.ms, 'ms', `${(bytes / 1_048_576).toFixed(1)} MB`);
  record('output', 'inline_tokens', inlineTokens, 'tokens', `${(bytes / 1_048_576).toFixed(1)} MB input`);
  record('output', 'compression', (processed.value.inline.length / Math.max(1, bytes)) * 100, '%', 'inline / input bytes');

  check('large output is kept out of context', inlineTokens < 4_000, `${inlineTokens} inline tokens from ${(bytes / 1_048_576).toFixed(1)} MB`);
  check('errors survive the spill', processed.value.errors.length >= 10, `${processed.value.errors.length} errors extracted`);

  // The full log stays retrievable on demand: reading the artifact back and
  // pulling out just the diagnostics must be cheap and precise (§56, §58).
  const slice = await time(async () => {
    const full = await readFile(processed.value.artifactPath as string, 'utf8');
    return full.split('\n').filter((line) => line.includes('error TS')).length;
  });
  record('output', 'artifact_grep_latency', slice.ms, 'ms');
  check(
    'artifact is retrievable on demand',
    slice.value >= 10,
    `${slice.value} diagnostics read back in ${slice.ms.toFixed(0)}ms`,
  );
}

/* ----------------------------------- main --------------------------------- */

async function main(): Promise<void> {
  const started = performance.now();
  const home = join(tmpdir(), `lc-bench-${Date.now()}`);
  await mkdir(home, { recursive: true });
  process.env.LOW_CONTEXT_HOME = join(home, 'home');

  console.log('Low Context benchmarks');
  console.log('======================');
  console.log(`node ${process.version}  |  scratch ${home}`);

  try {
    await benchIndexing(home);
    await benchRetrieval(home);
    await benchMemory(home);
    await benchContext(home);
    await benchLargeOutput(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }

  const failed = results.filter((result) => !result.passed);

  console.log('\n## Results');
  for (const result of results) {
    console.log(`   ${result.passed ? 'ok  ' : 'FAIL'} ${result.name} — ${result.detail}`);
  }

  console.log(`\n${results.length - failed.length}/${results.length} checks passed in ${((performance.now() - started) / 1000).toFixed(1)}s`);
  if (failed.length > 0) process.exitCode = 1;
}

await main();
