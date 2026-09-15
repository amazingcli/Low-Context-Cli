import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FileMemoryStore } from '../src/storage/memory-store.js';
import { candidateFromExplicitRemember, candidatesFromUserMessage, extractFromEvents, parseMemoryControl, } from '../src/memory/engine.js';
import { AgentEventLog } from '../src/core/logger.js';
import { tempDir } from './helpers.js';
async function store() {
    const dir = await tempDir('lc-mem-');
    return new FileMemoryStore({ baseDir: dir });
}
const projectA = 'project_aaa';
const projectB = 'project_bbb';
test('memory records persist with provenance, confidence and importance', async () => {
    const memory = await store();
    const record = await memory.write({
        type: 'DECISION',
        scope: 'project',
        summary: 'Authentication uses the existing OAuth provider, not a new one.',
        project_id: projectA,
        tags: ['auth'],
        source_refs: [{ kind: 'message', conversation_id: 'conv_1', message_id: 'msg_9' }],
        confidence: 'verified',
        importance: 'important',
    });
    assert.ok(record.id.startsWith('mem_'));
    assert.equal(record.status, 'current');
    assert.equal(record.confidence, 'verified');
    assert.equal(record.access_count, 0);
    assert.equal(record.source_refs.length, 1);
    const loaded = await memory.get(record.id);
    assert.equal(loaded?.summary, record.summary);
    // A retrieved record keeps a route back to its source (§8).
    const hits = await memory.search({ text: 'oauth authentication', project_id: projectA, limit: 5 });
    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.record.source_refs[0]?.message_id, 'msg_9');
});
test('search ranks exact symbol and path matches above generic prose', async () => {
    const memory = await store();
    await memory.write({
        type: 'PROJECT_KNOWLEDGE',
        scope: 'project',
        summary: 'The build system runs through the project scripts.',
        project_id: projectA,
    });
    await memory.write({
        type: 'FILE_KNOWLEDGE',
        scope: 'project',
        summary: 'backend/payments/receipt.go implements ParseReceipt and ValidateReceipt.',
        project_id: projectA,
    });
    const hits = await memory.search({ text: 'ParseReceipt', project_id: projectA, limit: 5 });
    assert.ok(hits.length >= 1);
    assert.match(hits[0]?.record.summary ?? '', /ParseReceipt/);
});
test('corrections supersede the old record instead of contradicting it', async () => {
    const memory = await store();
    const old = await memory.write({
        type: 'DECISION',
        scope: 'project',
        summary: 'Use library A for validation.',
        project_id: projectA,
        confidence: 'high',
    });
    const replacement = await memory.write({
        type: 'DECISION',
        scope: 'project',
        summary: 'Migrated to library B for validation.',
        project_id: projectA,
        confidence: 'verified',
        supersedes: old.id,
    });
    const oldAfter = await memory.get(old.id);
    assert.equal(oldAfter?.status, 'superseded');
    assert.equal(oldAfter?.superseded_by, replacement.id);
    const current = await memory.search({ text: 'validation library', project_id: projectA, limit: 5 });
    assert.equal(current.length, 1);
    assert.equal(current[0]?.record.id, replacement.id);
    const includingHistory = await memory.search({ text: 'validation library', project_id: projectA, limit: 5, include_superseded: true });
    assert.equal(includingHistory.length, 2);
});
test('memory is isolated per project and per scope', async () => {
    const memory = await store();
    await memory.write({ type: 'FACT', scope: 'project', summary: 'Project A uses PostgreSQL.', project_id: projectA });
    await memory.write({ type: 'FACT', scope: 'project', summary: 'Project B uses MySQL.', project_id: projectB });
    await memory.write({ type: 'PREFERENCE', scope: 'global', summary: 'User prefers concise output.' });
    const a = await memory.search({ text: 'uses', project_id: projectA, limit: 10 });
    assert.deepEqual(a.map((hit) => hit.record.summary), ['Project A uses PostgreSQL.']);
    assert.equal(await memory.count({ project_id: projectA }), 1);
    assert.equal(await memory.count({ project_id: projectB }), 1);
    assert.equal(await memory.count(), 3);
});
test('duplicate memories are merged rather than duplicated', async () => {
    const memory = await store();
    await memory.write({ type: 'FACT', scope: 'project', summary: 'The API is versioned under /v2.', project_id: projectA, confidence: 'medium' });
    await memory.write({ type: 'FACT', scope: 'project', summary: 'The API is versioned under /v2.', project_id: projectA, confidence: 'verified' });
    assert.equal(await memory.count({ project_id: projectA }), 1);
    const only = (await memory.list({ project_id: projectA }))[0];
    assert.equal(only?.confidence, 'verified');
});
test('delete and forget remove records and rebuild the search index', async () => {
    const memory = await store();
    const one = await memory.write({ type: 'FACT', scope: 'project', summary: 'Deployment uses Fly.io.', project_id: projectA });
    await memory.write({ type: 'FACT', scope: 'project', summary: 'Caching uses Redis.', project_id: projectA });
    assert.equal(await memory.delete(one.id), true);
    assert.equal(await memory.get(one.id), undefined);
    assert.equal(await memory.count({ project_id: projectA }), 1);
    assert.deepEqual(await memory.search({ text: 'Fly.io', project_id: projectA, limit: 5 }), []);
    const removed = await memory.forget({ text: 'Redis', project_id: projectA });
    assert.equal(removed, 1);
    assert.equal(await memory.count({ project_id: projectA }), 0);
});
test('rebuild reconstructs the lexical index from the record log', async () => {
    const memory = await store();
    await memory.write({ type: 'ARCHITECTURE', scope: 'project', summary: 'The gateway proxies to internal services.', project_id: projectA });
    const built = await memory.rebuild();
    assert.equal(built.records, 1);
    const hits = await memory.search({ text: 'gateway proxies', project_id: projectA, limit: 3 });
    assert.equal(hits.length, 1);
});
test('memory importance floor hides temporary records from search', async () => {
    const dir = await tempDir('lc-mem-');
    const memory = new FileMemoryStore({ baseDir: dir, minImportance: 'important' });
    await memory.write({ type: 'FACT', scope: 'project', summary: 'Temporary note about the integration spike.', project_id: projectA, importance: 'temporary' });
    await memory.write({ type: 'DECISION', scope: 'project', summary: 'Critical decision about the integration contract.', project_id: projectA, importance: 'critical' });
    const hits = await memory.search({ text: 'integration', project_id: projectA, limit: 10 });
    assert.deepEqual(hits.map((hit) => hit.record.importance), ['critical']);
    // The same floor applies when a query returns recent records by recency.
    const recent = await memory.search({ project_id: projectA, limit: 10 });
    assert.ok(recent.every((hit) => hit.record.importance !== 'temporary'));
    // The record is still stored — it is filtered from retrieval, not destroyed.
    assert.equal(await memory.count({ project_id: projectA }), 2);
});
test('explicit user instructions become memories; guesses do not', () => {
    const explicit = candidateFromExplicitRemember('remember this: the staging database is read-only', {
        projectId: projectA,
    });
    assert.equal(explicit?.type, 'FACT');
    assert.equal(explicit?.confidence, 'verified');
    assert.equal(explicit?.importance, 'important');
    assert.equal(candidateFromExplicitRemember('what does this function do?', { projectId: projectA }), undefined);
    const preferences = candidatesFromUserMessage('I always prefer narrow, reviewable diffs.', { projectId: projectA });
    assert.equal(preferences[0]?.type, 'PREFERENCE');
    assert.deepEqual(candidatesFromUserMessage('why is the build slow?', { projectId: projectA }), []);
});
test('memory control directives are parsed and never confuse forget with remember', () => {
    assert.equal(parseMemoryControl('remember that we deploy on Fridays').type, 'remember');
    assert.equal(parseMemoryControl("don't remember this").type, 'dont_remember');
    assert.equal(parseMemoryControl('forget the redis decision').type, 'forget');
    assert.equal(parseMemoryControl('show my memory').type, 'show');
    assert.equal(parseMemoryControl('fix the login bug').type, 'none');
});
test('only verified events produce memory records', () => {
    const events = new AgentEventLog();
    events.record('verification', 'npm test passed', { passed: true, command: 'npm test' });
    events.record('verification', 'npm test failed', { passed: false, command: 'npm test' });
    events.record('edit', 'edited src/auth/service.ts', { file: 'src/auth/service.ts' });
    events.record('request', 'user asked something'); // not durable
    const result = extractFromEvents(events.all(), { projectId: projectA });
    const summaries = result.written.map((record) => record.summary);
    assert.ok(summaries.some((summary) => summary.includes('Verified: npm test')), `expected the command fallback to name the check, got ${JSON.stringify(summaries)}`);
    assert.ok(summaries.some((summary) => summary.includes('src/auth/service.ts')));
    assert.ok(!summaries.some((summary) => summary.includes('user asked something')));
    assert.equal(result.skipped.length, 1);
    for (const record of result.written)
        assert.equal(record.confidence, 'verified');
});
//# sourceMappingURL=memory.test.js.map