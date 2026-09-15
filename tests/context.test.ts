import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ContextBuilder, renderBudgetLine } from '../src/context/builder.js';
import { estimateTokens, estimateMessagesTokens, formatTokens } from '../src/context/estimator.js';
import { compactMessages, extractiveSummarize, shouldCompact } from '../src/context/compactor.js';
import { FileConversationStore } from '../src/storage/conversation-store.js';
import { FileMemoryStore } from '../src/storage/memory-store.js';
import { tempDir } from './helpers.js';
import type { ContextItem } from '../src/core/types.js';

function item(kind: ContextItem['kind'], content: string, priority = 0.5): Omit<ContextItem, 'tokens'> & { content: string } {
  return { id: `ctx:${kind}:${content.slice(0, 6)}`, kind, priority, content, label: `${kind} item` };
}

test('token estimation is monotonic, cheap for ASCII and wide for CJK', () => {
  assert.equal(estimateTokens('').tokens, 0);
  const short = estimateTokens('hello world').tokens;
  const long = estimateTokens('hello world hello world hello world').tokens;
  assert.ok(long > short);

  const cjk = estimateTokens('これは日本語のテキストです').tokens;
  assert.ok(cjk >= 12, `CJK should cost about one token per character, got ${cjk}`);

  assert.equal(formatTokens(999), '999');
  assert.equal(formatTokens(1_500), '1.5k');
  assert.equal(estimateMessagesTokens([{ content: 'abc' }, { content: 'def' }]), estimateTokens('abc').tokens + estimateTokens('def').tokens);
});

test('the builder keeps system and task items regardless of budget', () => {
  const builder = new ContextBuilder({ modelContextLimit: 1_000, reserveOutputTokens: 200, strategy: 'minimal' });
  builder.add({ ...item('system', 'S'.repeat(400)), priority: 1 });
  builder.add(item('code', 'C'.repeat(4_000)));
  const selected = builder.build();
  assert.ok(selected.some((entry) => entry.kind === 'system'));
});

test('strategy shares cap how much each category may consume', () => {
  const builder = new ContextBuilder({ modelContextLimit: 10_000, reserveOutputTokens: 0, strategy: 'minimal' });
  builder.add(item('system', 'instructions'));
  builder.add(item('memory', 'M'.repeat(4_000)));
  builder.add(item('code', 'C'.repeat(4_000)));
  const selected = builder.build();
  const report = builder.report(selected);

  const memoryTokens = selected.filter((entry) => entry.kind === 'memory').reduce((sum, entry) => sum + entry.tokens, 0);
  // minimal allots 8% of a 10k window to memory.
  assert.ok(memoryTokens <= 800, `memory slice should respect its share, got ${memoryTokens}`);

  assert.ok(report.slices.length > 0);
  assert.equal(report.strategy, 'minimal');
  assert.ok(report.utilization > 0 && report.utilization <= 1);
  assert.match(renderBudgetLine(report), /Context Budget/);
});

test('items that do not fit are reported as dropped, never silently omitted', () => {
  const builder = new ContextBuilder({ modelContextLimit: 600, reserveOutputTokens: 100, strategy: 'balanced' });
  builder.add(item('system', 'sys'));
  for (let i = 0; i < 10; i += 1) builder.add(item('code', `file ${i} `.repeat(60)));
  const selected = builder.build();
  const report = builder.report(selected);
  assert.ok(report.dropped.length > 0);
  assert.ok(report.used_tokens <= report.usable_tokens);
});

test('deep strategy admits more code than minimal, but still bounded', () => {
  const make = (strategy: 'minimal' | 'deep') => {
    const builder = new ContextBuilder({ modelContextLimit: 20_000, reserveOutputTokens: 0, strategy });
    builder.add(item('system', 'system instructions'));
    for (let i = 0; i < 40; i += 1) builder.add(item('code', `export function fn${i}() { return ${i}; }`.repeat(20)));
    const selected = builder.build();
    return { selected, report: builder.report(selected) };
  };
  const minimal = make('minimal');
  const deep = make('deep');
  assert.ok(deep.report.used_tokens > minimal.report.used_tokens);
  assert.ok(deep.report.used_tokens <= deep.report.usable_tokens);
});

test('shouldCompact fires only past the threshold', () => {
  assert.equal(shouldCompact(100, 1_000, 0.7), false);
  assert.equal(shouldCompact(750, 1_000, 0.7), true);
  assert.equal(shouldCompact(500, 0, 0.7), false);
});

test('extractive summarisation preserves decisions and outcomes', () => {
  const messages = [
    { id: 'm1', conversation_id: 'c', timestamp: '', role: 'user' as const, content: 'We decided to use the existing OAuth implementation rather than writing a new one.' },
    { id: 'm2', conversation_id: 'c', timestamp: '', role: 'assistant' as const, content: 'Understood. I will wire the existing provider into the login route.' },
    { id: 'm3', conversation_id: 'c', timestamp: '', role: 'assistant' as const, content: 'The test run passed after the fix.' },
    { id: 'm4', conversation_id: 'c', timestamp: '', role: 'user' as const, content: 'The staging API base url is /v2.' },
  ];
  const summary = extractiveSummarize(messages);
  assert.match(summary.summary, /Decisions/);
  assert.equal(summary.decisions.length, 1);
  assert.match(summary.decisions[0] as string, /OAuth implementation/);
  assert.ok(summary.facts.length > 0, 'non-decision user statements are kept as context');
});

test('compaction writes memory records with source references and keeps the transcript', async () => {
  const dir = await tempDir('lc-ctx-');
  const conversations = new FileConversationStore({ baseDir: dir });
  const memory = new FileMemoryStore({ baseDir: dir });
  const conversation = await conversations.create({ project_id: 'project_x' });

  const appended = [];
  for (let i = 0; i < 6; i += 1) {
    appended.push(
      await conversations.append(conversation.id, {
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: i === 0 ? 'We decided to use Redis for caching the session tokens.' : `Message number ${i} with some longer body text to summarise.`,
      }),
    );
  }

  const stored = await conversations.messages(conversation.id);
  const result = await compactMessages({
    messages: stored,
    conversationId: conversation.id,
    conversationStore: conversations,
    memoryStore: memory,
    projectId: 'project_x',
  });

  assert.ok(result.tokens_freed > 0);
  assert.ok(result.memoryRecords.length > 0);
  assert.ok(result.keptMessages.length > 0);

  // Summaries point back at the original messages (§8) and the raw log is intact.
  const records = await memory.list({ project_id: 'project_x' });
  assert.ok(records.length > 0);
  const withRefs = records.filter((record) => record.source_refs.length > 0);
  assert.ok(withRefs.length > 0);
  for (const ref of withRefs[0]?.source_refs ?? []) {
    assert.ok((await conversations.messagesByIds([ref.message_id as string])).length === 1);
  }
  assert.equal((await conversations.messages(conversation.id)).length, 6);

  const updated = await conversations.get(conversation.id);
  assert.ok(updated?.summary);
});
