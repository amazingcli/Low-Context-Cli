import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runRetrieval, candidatesToContextItems } from '../src/retrieval/engine.js';
import { understandQuery, planForIntent } from '../src/retrieval/intent.js';
import { normalizeLexical, rankCandidates, dedupe, scoreCandidate } from '../src/search/rank.js';
import { tokenize, analyzeQuery, splitIdentifier } from '../src/search/tokenize.js';
import { refreshProjectIndex } from '../src/index/indexer.js';
import { FileIndexStore } from '../src/index/index-store.js';
import { FileMemoryStore } from '../src/storage/memory-store.js';
import { FileConversationStore } from '../src/storage/conversation-store.js';
import { projectIdForRoot } from '../src/storage/project-store.js';
import { defaultConfig } from '../src/core/config.js';
import { makeProject, tempDir } from './helpers.js';
test('query understanding separates change, question, historical and whole-project intent', () => {
    assert.equal(understandQuery('fix the login timeout bug').kind, 'code_change');
    assert.equal(understandQuery('why is the payment system slow?').kind, 'question');
    assert.equal(understandQuery('what database decision did we make last month?').kind, 'memory_query');
    assert.equal(understandQuery('analyze the whole app and redesign it').whole_project, true);
    assert.equal(understandQuery('analyze the whole app').kind, 'analysis');
    const intent = understandQuery('parseReceipt in src/payments/receipt.ts is wrong');
    assert.ok(intent.paths.includes('src/payments/receipt.ts'));
    assert.ok(intent.symbols.includes('parseReceipt'));
    const modules = [
        { id: 'mod_1', project_id: 'p', path: 'src/payments', name: 'payments', file_count: 3, languages: ['typescript'], top_symbols: [], entry_points: [], updated_at: '' },
    ];
    assert.deepEqual(understandQuery('why is the payment module failing', modules).modules, ['payments']);
});
test('retrieval plans differ by intent', () => {
    const change = planForIntent(understandQuery('fix the receipt parser'));
    const historical = planForIntent(understandQuery('what did we decide about the database last month'));
    assert.ok(change.stages.some((stage) => stage.name === 'files'));
    assert.equal(historical.stages[0]?.name, 'memory');
});
test('tokenizer splits camelCase, snake_case and paths', () => {
    assert.deepEqual(splitIdentifier('parseReceipt').map((part) => part.toLowerCase()), ['parse', 'receipt']);
    assert.ok(splitIdentifier('read_receipt_file').includes('receipt'));
    assert.ok(tokenize('src/payments/receipt.go ParseReceipt').includes('receipt'));
    const queryTerms = analyzeQuery('Fix ParseReceipt');
    assert.ok(queryTerms.raw.includes('parse'));
    assert.ok(queryTerms.terms.includes('receipt'));
    assert.deepEqual(queryTerms.identifiers, ['ParseReceipt']);
});
test('lexical scores saturate and ranking rewards exact and verified matches', () => {
    assert.equal(normalizeLexical(0), 0);
    assert.ok(normalizeLexical(4) > 0.3 && normalizeLexical(4) < 0.5);
    assert.ok(normalizeLexical(40) > 0.8);
    const ranked = rankCandidates([
        { id: 'weak', lexical: 1 },
        { id: 'strong', lexical: 9, exact: 1, verified: 1 },
    ]);
    assert.equal(ranked[0]?.id, 'strong');
    assert.ok((ranked[0]?.reasons.length ?? 0) > 0);
    const scored = scoreCandidate({ id: 'x', lexical: 5, importance: 'critical', confidence: 'verified' });
    assert.ok(scored.score > scoreCandidate({ id: 'y', lexical: 5, importance: 'temporary', confidence: 'unknown' }).score);
});
test('dedupe collapses near-identical candidates and keeps the best', () => {
    const items = rankCandidates([
        { id: 'a', lexical: 5 },
        { id: 'b', lexical: 4 },
        { id: 'c', lexical: 1 },
    ]);
    const result = dedupe(items, { threshold: 0.9, keyOf: (item) => (item.id === 'a' || item.id === 'b' ? 'same' : item.id) });
    assert.equal(result.kept.length, 2);
    assert.equal(result.kept[0]?.id, 'a');
    assert.equal(result.dropped.length, 1);
    // Items that carry no comparable text must not be treated as duplicates.
    const noText = rankCandidates([{ id: 'x', lexical: 2 }, { id: 'y', lexical: 1 }]);
    assert.equal(dedupe(noText).kept.length, 2);
});
test('runRetrieval reads the real source for the chosen candidates', async () => {
    const root = await makeProject({
        'src/payments/receipt.ts': 'export function parseReceipt(input: string): number {\n  return Number(input);\n}\n',
        'src/payments/receipt.test.ts': 'export const tested = true;\n',
        'src/auth/service.ts': 'export function login(): void {}\n',
        'src/unrelated/thing.ts': 'export const unrelated = 1;\n',
    });
    const dir = await tempDir('lc-ret-');
    const indexStore = new FileIndexStore(dir);
    const memoryStore = new FileMemoryStore({ baseDir: dir });
    const conversationStore = new FileConversationStore({ baseDir: dir });
    const projectId = projectIdForRoot(root);
    await refreshProjectIndex({ root, projectId, store: indexStore, force: true });
    await memoryStore.write({
        type: 'BUG',
        scope: 'project',
        summary: 'parseReceipt previously mishandled amounts with currency symbols.',
        project_id: projectId,
        confidence: 'verified',
        importance: 'important',
        source_refs: [{ kind: 'message', conversation_id: 'conv_old', message_id: 'msg_12' }],
    });
    const output = await runRetrieval({
        config: defaultConfig(),
        indexStore,
        memoryStore,
        conversationStore,
        projectRoot: root,
        projectId,
    }, { query: 'parseReceipt is mishandling currency amounts', trace: true });
    assert.equal(output.intent.kind, 'code_change');
    const receipt = output.candidates.find((candidate) => candidate.file_path === 'src/payments/receipt.ts');
    assert.ok(receipt, 'the receipt file should be retrieved');
    // Verification (§16): the candidate carries real file content read from disk.
    assert.equal(receipt?.verified, true);
    assert.match(receipt?.content ?? '', /function parseReceipt/);
    assert.ok(output.trace.steps.length > 0, 'the trace records what each stage did');
    assert.ok(output.trace.steps.some((step) => step.stage === 'verify'));
    assert.ok(output.candidates.every((candidate) => typeof candidate.reason === 'string' && candidate.reason.length > 0));
    // Memory is retrieved for a code question when it is relevant.
    const memoryItem = output.memory.find((record) => record.summary.includes('parseReceipt'));
    assert.ok(memoryItem);
    const items = candidatesToContextItems(output.candidates, { maxBytes: 8_192 });
    assert.ok(items.some((item) => item.kind === 'code'));
    assert.ok(items.every((item) => item.untrusted === true), 'retrieved code is untrusted data by default');
});
test('retrieval stays inside the project and reports an empty result honestly', async () => {
    const root = await makeProject({ 'src/a.ts': 'export const a = 1;\n' });
    const dir = await tempDir('lc-ret-');
    const indexStore = new FileIndexStore(dir);
    const projectId = projectIdForRoot(root);
    await refreshProjectIndex({ root, projectId, store: indexStore, force: true });
    const output = await runRetrieval({
        config: defaultConfig(),
        indexStore,
        memoryStore: new FileMemoryStore({ baseDir: dir }),
        conversationStore: new FileConversationStore({ baseDir: dir }),
        projectRoot: root,
        projectId,
    }, { query: 'quantum flux capacitor calibration' });
    assert.equal(output.candidates.length, 0);
    assert.equal(output.trace.candidates.length, 0);
});
test('historical questions search conversation history, not only recent context', async () => {
    const root = await makeProject({ 'src/a.ts': 'export const a = 1;\n' });
    const dir = await tempDir('lc-ret-');
    const indexStore = new FileIndexStore(dir);
    const memoryStore = new FileMemoryStore({ baseDir: dir });
    const conversationStore = new FileConversationStore({ baseDir: dir });
    const projectId = projectIdForRoot(root);
    await refreshProjectIndex({ root, projectId, store: indexStore, force: true });
    const old = await conversationStore.create({ project_id: projectId });
    await conversationStore.append(old.id, { role: 'user', content: 'What database should we use for the audit log?' });
    await conversationStore.append(old.id, { role: 'assistant', content: 'We chose PostgreSQL with a monthly partition.' });
    const output = await runRetrieval({ config: defaultConfig(), indexStore, memoryStore, conversationStore, projectRoot: root, projectId }, { query: 'what database did we decide on for the audit log earlier', trace: true });
    assert.ok(output.trace.steps.some((step) => step.stage === 'conversation'));
    assert.ok(output.intent.historical);
});
//# sourceMappingURL=retrieval.test.js.map