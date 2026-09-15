import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { JsonlLog } from '../src/storage/jsonl.js';
import { PersistentLexicalIndex } from '../src/storage/lexical-index.js';
import { InvertedIndex } from '../src/search/bm25.js';
import { LocalVectorStore } from '../src/storage/vector-store.js';
import { HashingEmbedder } from '../src/storage/embedder.js';
import { redact, redactString, containsSecret, buildChildEnv } from '../src/security/redact.js';
import { tempDir } from './helpers.js';
test('JsonlLog appends, reads by ordinal and rebuilds a stale offset file', async () => {
    const dir = await tempDir();
    const path = join(dir, 'rows.jsonl');
    const log = new JsonlLog(path, { flushEvery: 2 });
    // Reading an empty (not yet created) log must not throw — a fresh install
    // hits this path every time.
    assert.deepEqual(await log.all(), []);
    for (let i = 0; i < 5; i += 1)
        await log.append({ id: `r${i}`, value: i });
    assert.equal(log.size, 5);
    assert.deepEqual(await log.at(0), { id: 'r0', value: 0 });
    assert.deepEqual(await log.at(-1), { id: 'r4', value: 4 });
    assert.deepEqual((await log.tail(2)).map((r) => r.id), ['r3', 'r4']);
    assert.deepEqual((await log.range(1, 2)).map((r) => r.value), [1, 2]);
    // Truncating the data file behind the log's back must trigger a rebuild
    // rather than silently returning wrong records (§45).
    await log.flush();
    const fresh = new JsonlLog(path);
    await fresh.truncateTo(0);
    assert.equal(fresh.size, 0);
    await fresh.close();
});
test('JsonlLog retain rewrites the log and keeps offsets consistent', async () => {
    const dir = await tempDir();
    const log = new JsonlLog(join(dir, 'rows.jsonl'));
    await log.appendMany([
        { id: 'a', value: 1 },
        { id: 'b', value: 2 },
        { id: 'c', value: 3 },
    ]);
    const result = await log.retain((row) => row.value !== 2);
    assert.deepEqual(result, { kept: 2, removed: 1 });
    assert.deepEqual((await log.all()).map((r) => r.id), ['a', 'c']);
    const reloaded = new JsonlLog(join(dir, 'rows.jsonl'));
    assert.deepEqual((await reloaded.all()).map((r) => r.id), ['a', 'c']);
});
test('InvertedIndex ranks documents by BM25 and reports matched terms', () => {
    const index = new InvertedIndex();
    index.upsert('auth', 'authentication oauth token refresh login');
    index.upsert('payments', 'payment receipt parse validate charge');
    index.upsert('docs', 'readme installation instructions');
    const hits = index.searchText('receipt payment', { limit: 3 });
    assert.equal(hits[0]?.id, 'payments');
    assert.ok(hits[0]?.matched.includes('receipt'));
    assert.ok((hits[0]?.score ?? 0) > 0);
    assert.equal(hits.find((hit) => hit.id === 'docs'), undefined);
});
test('InvertedIndex survives a serialise/deserialise round trip', () => {
    const index = new InvertedIndex();
    index.upsert('a', 'shared unique_alpha');
    index.upsert('b', 'shared unique_beta');
    const restored = InvertedIndex.deserialize(JSON.parse(JSON.stringify(index.serialize())));
    assert.equal(restored.docCount, 2);
    assert.equal(restored.searchText('unique_beta', { limit: 1 })[0]?.id, 'b');
});
test('PersistentLexicalIndex persists through its debounced flush without recursing', async () => {
    const dir = await tempDir();
    const path = join(dir, 'lex.json');
    const index = new PersistentLexicalIndex(path, 5);
    await index.upsert('doc1', 'context budgeting retrieval');
    await index.upsert('doc2', 'memory records corrections');
    await index.flush();
    const reloaded = new PersistentLexicalIndex(path);
    const hits = await reloaded.search('retrieval', { limit: 1 });
    assert.equal(hits[0]?.id, 'doc1');
    const raw = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(raw.doc_count, 2);
});
test('LocalVectorStore returns exact nearest neighbours and survives reload', async () => {
    const dir = await tempDir();
    const embedder = new HashingEmbedder(64);
    const vectors = await embedder.embed(['authentication token', 'payment receipt', 'unrelated prose']);
    const store = new LocalVectorStore(dir);
    await store.upsert([
        { id: 'auth', vector: vectors[0] },
        { id: 'pay', vector: vectors[1] },
        { id: 'doc', vector: vectors[2] },
    ]);
    await store.flush();
    const query = (await embedder.embed(['token authentication']))[0];
    const matches = await store.search(query, 2);
    assert.equal(matches[0]?.id, 'auth');
    const reloaded = new LocalVectorStore(dir);
    assert.equal(await reloaded.count(), 3);
    assert.equal((await reloaded.search(query, 1))[0]?.id, 'auth');
    await reloaded.remove(['auth']);
    assert.equal(await reloaded.count(), 2);
});
test('HashingEmbedder is deterministic and L2-normalised', async () => {
    const embedder = new HashingEmbedder(32);
    const [first] = await embedder.embed(['hello world']);
    const [second] = await embedder.embed(['hello world']);
    assert.deepEqual(Array.from(first), Array.from(second));
    const norm = Math.sqrt(Array.from(first).reduce((sum, value) => sum + value * value, 0));
    assert.ok(Math.abs(norm - 1) < 1e-3, `expected unit norm, got ${norm}`);
});
test('redaction masks credentials without destroying structure', () => {
    const text = 'OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz012345\nnormal: value';
    assert.ok(containsSecret(text));
    const masked = redactString(text);
    assert.ok(!masked.includes('sk-proj-abcdefghijklmnopqrstuvwxyz012345'));
    assert.ok(masked.includes('normal: value'));
    const nested = redact({ authorization: 'Bearer abcdefghijklmnopqrstuvwxyz', keep: 'yes' });
    assert.equal(nested.keep, 'yes');
    assert.ok(!nested.authorization?.includes('abcdefghijklmnopqrstuvwxyz'));
});
test('buildChildEnv drops credential-like variables by default', () => {
    const env = buildChildEnv({ PATH: '/usr/bin', OPENAI_API_KEY: 'sk-secret', ANTHROPIC_API_KEY: 'sk-other', HOME: '/home/x' }, {});
    assert.equal(env.PATH, '/usr/bin');
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
    assert.equal(env.OPENAI_API_KEY, undefined);
    const allowListed = buildChildEnv({ PATH: '/usr/bin', MY_TOKEN: 'x' }, { allow: ['PATH', 'MY_TOKEN'] });
    assert.equal(allowListed.MY_TOKEN, 'x');
});
//# sourceMappingURL=storage.test.js.map