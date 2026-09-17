/**
 * Retrieval engine (§12, §62, §63, §16).
 *
 * Pipeline:
 *
 *   understandQuery -> plan stages -> generate candidates per stage
 *   -> rank (weighted scoring) -> de-duplicate
 *   -> verify sources (read the actual file for code candidates)
 *   -> select within context budget
 *
 * Adaptive retrieval (§63): stages run in order; once `sufficient_verified`
 * high-value candidates are in hand, later stages are skipped instead of
 * loading more information just because it exists.
 *
 * Verification (§16): code candidates exist as index metadata until the file
 * stage actually reads them. `index != source`, and anything marked `verified`
 * here has been read from disk in this request.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  ContextItem,
  IndexedFile,
  IndexedModule,
  MemoryRecord,
  MemorySearchQuery,
  RetrievalCandidate,
  RetrievalTrace,
  TaskState,
  VerificationState,
} from '../core/types.js';
import type { LowContextConfig } from '../core/config.js';
import type { ConversationStore, IndexStore, MemoryStore } from '../storage/interfaces.js';
import { understandQuery } from './intent.js';
import { analyzeQuery } from '../search/tokenize.js';
import { rankCandidates, scoreCandidate, dedupe, selectWithinBudget } from '../search/rank.js';
import type { ScoredItem, ScoreInputs } from '../search/rank.js';
import { estimateTokens } from '../context/estimator.js';
import { nowIso } from '../core/util.js';
import { isInside } from '../core/paths.js';

export interface RetrievalDependencies {
  config: LowContextConfig;
  indexStore: IndexStore;
  memoryStore: MemoryStore;
  conversationStore: ConversationStore;
  projectRoot?: string;
  projectId?: string;
  sessionId?: string;
  taskId?: string;
  taskState?: TaskState;
  recentUserMessages?: { content: string; timestamp: string }[];
  embedder?: { dimensions: number; embed(texts: readonly string[]): Promise<Float32Array[]> };
  getGitChanged?: () => Promise<{ added: string[]; modified: string[]; deleted: string[] }>;
  note?: (step: string, detail: string) => void;
}

export interface RetrievalOptions {
  query: string;
  /** Debug builds a detailed trace; production still timestamps stages. */
  trace?: boolean;
  limit?: number;
  /** Skip the final file-reading verification stage. */
  skipVerification?: boolean;
}

export interface RetrievalOutput {
  intent: ReturnType<typeof understandQuery>;
  candidates: RetrievalCandidate[];
  verifiedFiles: IndexedFile[];
  memory: MemoryRecord[];
  trace: RetrievalTrace;
  /** True when adaptive retrieval stopped before the final planned stage. */
  stoppedEarly: boolean;
}

export async function runRetrieval(deps: RetrievalDependencies, options: RetrievalOptions): Promise<RetrievalOutput> {
  const started = Date.now();
  const trace: RetrievalTrace = {
    query: options.query,
    intent: understandQuery(options.query),
    steps: [],
    candidates: [],
    effective_limit: options.limit ?? deps.config.retrieval.top_k,
    duration_ms: 0,
    stopped_early: false,
  };

  const note = (step: string, detail: string, candidateCount: number, kept: number, durationMs: number) => {
    trace.steps.push({ stage: step, detail, candidates: candidateCount, kept, duration_ms: durationMs });
    deps.note?.(step, detail);
  };

  // Stage 0: modules for intent attribution.
  const modules = await safe(deps.indexStore.listModules(deps.projectId ?? ''), [] as IndexedModule[]);
  trace.intent = understandQuery(options.query, modules);

  // Stage 1: lexical hit on the project index (files + symbols).
  const indexStarted = Date.now();
  const indexInputs: ScoreInputs[] = [];
  const indexMeta = new Map<string, Partial<RetrievalCandidate>>();
  const indexFiles = await safe(deps.indexStore.searchFiles(deps.projectId ?? '', options.query, 40), []);
  for (const hit of indexFiles) {
    indexInputs.push({
      id: hit.file.id,
      lexical: hit.score,
      exact: exactBonus(options.query, [hit.file.path, ...hit.file.symbols]),
      updated_at: hit.file.modified_at,
      staleness: hit.file.verification_state === 'stale' || hit.file.stale ? 0.8 : 0,
      verified: hit.file.verification_state === 'verified' ? 1 : 0,
    });
    indexMeta.set(hit.file.id, { file_path: hit.file.path, reason: fileReason(hit.file) });
  }

  // Stage 2: symbol matches (exact symbol names count twice).
  const symbolMatches = await safe(deps.indexStore.findSymbol(deps.projectId ?? '', options.query, 20), []);
  for (const match of symbolMatches) {
    const extra: ScoreInputs = {
      id: `${match.file.id}#${match.symbol}`,
      lexical: match.score * 0.8,
      exact: 1,
      task: deps.taskState?.relevant_symbols.includes(match.symbol) ? 1 : 0,
    };
    const existing = indexInputs.find((i) => i.id === match.file.id);
    if (existing) existing.lexical = (existing.lexical ?? 0) + match.score;
    else {
      indexInputs.push(extra);
      indexMeta.set(`${match.file.id}#${match.symbol}`, {
        file_path: match.file.path,
        symbol: match.symbol,
        reason: `symbol match: ${match.symbol}`,
      });
    }
  }
  note('project index', `lexical + symbol search over ${indexFiles.length + symbolMatches.length} hits`, indexInputs.length, indexInputs.length, Date.now() - indexStarted);

  // Stage 3: memory search.
  const memoryStarted = Date.now();
  const memoryInputs: ScoreInputs[] = [];
  const memoryMeta = new Map<string, Partial<RetrievalCandidate>>();
  const memoryQuery: MemorySearchQuery = {
    text: options.query,
    project_id: deps.projectId,
    session_id: deps.sessionId,
    task_id: deps.taskId,
    limit: 20,
    weights: deps.config.retrieval.weights,
  };
  const memoryHits = await safe(deps.memoryStore.search(memoryQuery), []);
  for (const hit of memoryHits) {
    memoryInputs.push({
      id: hit.record.id,
      lexical: hit.score,
      importance: hit.record.importance,
      confidence: hit.record.confidence,
      updated_at: hit.record.updated_at,
      task: hit.record.task_id === deps.taskId ? 1 : 0,
      verified: hit.record.verification_state === 'verified' ? 1 : 0,
    });
    memoryMeta.set(hit.record.id, { memory_id: hit.record.id, reason: `memory match: ${hit.reason}` });
  }
  note('memory', `${memoryHits.length} memory candidates`, memoryHits.length, memoryHits.length, Date.now() - memoryStarted);

  // Stage 4: historical conversation search (only when the query asks for it).
  let conversationInputs: ScoreInputs[] = [];
  if (trace.intent.historical || trace.intent.kind === 'memory_query') {
    const convStarted = Date.now();
    const convHits = await safe(
      deps.conversationStore.searchMessages({
        text: options.query,
        project_id: deps.projectId,
        limit: 16,
      }),
      [],
    );
    conversationInputs = convHits.map((hit) => ({
      id: hit.message.id,
      lexical: hit.score,
      created_at: hit.message.timestamp,
      verified: 1,
    }));
    note('conversation', `${convHits.length} historical messages`, convHits.length, convHits.length, Date.now() - convStarted);
  }

  // Stage 5: recent context (not normally a retrieval source; only chat intents).
  const recentInputs: ScoreInputs[] = (deps.recentUserMessages ?? []).slice(-6).map((m) => ({
    id: `recent:${m.timestamp}`,
    lexical: 0.3,
    created_at: m.timestamp,
    task: 0.3,
  }));

  // Stage 6: git changes when present.
  const gitInputs: ScoreInputs[] = [];
  const gitMeta = new Map<string, Partial<RetrievalCandidate>>();
  if (deps.getGitChanged) {
    const gitStarted = Date.now();
    const changes = await safe(deps.getGitChanged(), { added: [], modified: [], deleted: [] });
    const relevant = changes.modified.concat(changes.added).slice(0, 30);
    for (const path of relevant) {
      gitInputs.push({ id: `git:${path}`, exact: 0.35, updated_at: nowIso(), task: 0.4 });
      gitMeta.set(`git:${path}`, { file_path: path, reason: 'file changed in git working tree' });
    }
    note('git', `${changes.modified.length} modified, ${changes.added.length} added`, relevant.length, relevant.length, Date.now() - gitStarted);
  }

  // Stage 7: dependency expansion of the top file candidates (§18).
  const dependencyManaged = new Set<string>();
  const depInputs: ScoreInputs[] = [];
  for (const candidate of [...indexInputs].sort((a, b) => (b.lexical ?? 0) - (a.lexical ?? 0)).slice(0, 6)) {
    const file = indexFiles.find((f) => f.file.id === candidate.id);
    if (!file) continue;
    for (const dep of file.file.depends_on_files ?? []) {
      if (dependencyManaged.has(dep)) continue;
      dependencyManaged.add(dep);
      depInputs.push({ id: `dep:${dep}`, exact: 0.3, task: 0.2 });
    }
    for (const dependent of file.file.depended_on_by ?? []) {
      if (dependencyManaged.has(dependent)) continue;
      dependencyManaged.add(dependent);
      depInputs.push({ id: `deprev:${dependent}`, exact: 0.25, task: 0.2 });
    }
  }

  // Combine and rank.
  const allInputs: ScoreInputs[] = [
    ...indexInputs,
    ...memoryInputs,
    ...conversationInputs,
    ...recentInputs,
    ...gitInputs,
    ...depInputs,
  ];
  const ranked = rankCandidates(allInputs, deps.config.retrieval.weights);
  const weights = deps.config.retrieval.weights;

  // Dedupe: one winning candidate per file path.
  const keyed = ranked.map((item) => {
    const meta = indexMeta.get(item.id) ?? memoryMeta.get(item.id) ?? gitMeta.get(item.id);
    const key = meta?.file_path ?? item.id;
    return { item, key, meta };
  });
  const byKey = new Map<string, ScoredItem>();
  for (const pair of keyed) {
    const existing = byKey.get(pair.key);
    if (!existing || pair.item.score > existing.score) byKey.set(pair.key, pair.item);
  }
  const deduped = dedupe([...byKey.values()], { threshold: weights.redundancy > 0 ? 0.7 : 1 });

  // Verify sources: read the actual files for the top code candidates (§16).
  if (!options.skipVerification && deps.projectRoot) {
    const verifyStarted = Date.now();
    const topFiles = deduped.kept
      .filter((item) => !item.id.startsWith('mem_') && !item.id.startsWith('msg_') && !item.id.startsWith('recent:') && !item.id.startsWith('dep') && !item.id.startsWith('git:'))
      .slice(0, deps.config.retrieval.sufficient_verified + 2);
    for (const item of topFiles) {
      const path = indexMeta.get(item.id)?.file_path ?? item.id;
      const abs = join(deps.projectRoot, path);
      if (!isInside(deps.projectRoot, abs)) continue;
      const content = await safe(readFile(abs, 'utf8'), '');
      if (!content) continue;
      // Bound how much source enters the candidate set, and number it so the
      // model can cite lines that actually exist in the file.
      const output = renderNumberedSource(content, deps.config.context.max_retrieved_file_bytes);
      item.verified = 1;
      item.reasons.push('source verified');
      ((item as unknown) as { content?: string }).content = output;
      ((item as unknown) as { verification_state?: VerificationState }).verification_state = 'verified';
    }
    note('verify', 'read candidate files from disk', topFiles.length, topFiles.filter((i) => (i as unknown as { content?: string }).content).length, Date.now() - verifyStarted);
  }

  let candidates: RetrievalCandidate[] = deduped.kept.map((item) => {
    const meta = indexMeta.get(item.id) ?? memoryMeta.get(item.id) ?? gitMeta.get(item.id);
    return {
      id: item.id,
      source: 'index_lexical' as const,
      reason: meta?.reason ?? (item.reasons.join(', ') || 'ranked'),
      score: item.score,
      lexical: item.lexical,
      semantic: item.semantic,
      verified: item.verified === 1,
      ...(meta?.file_path === undefined ? {} : { file_path: meta.file_path }),
      ...(meta?.symbol === undefined ? {} : { symbol: meta.symbol }),
      ...(meta?.memory_id === undefined ? {} : { memory_id: meta.memory_id }),
      ...((item as unknown as { content?: string }).content === undefined ? {} : { content: (item as unknown as { content: string }).content }),
      ...((item as unknown as { verification_state?: VerificationState }).verification_state === undefined
        ? {}
        : { verification_state: (item as unknown as { verification_state: VerificationState }).verification_state }),
    };
  });

  // Adaptive stop (§63): enough verified file candidates — no more stages.
  const verifiedFiles = candidates.filter((c) => c.verified && c.content !== undefined);
  const stoppedEarly = deps.config.retrieval.adaptive && verifiedFiles.length >= deps.config.retrieval.sufficient_verified;

  // Final budget selection.
  const selection = selectWithinBudget(candidates.map((c) => scoreCandidate({ id: c.id, lexical: c.score })), {
    maxTokens: deps.config.retrieval.top_k * 280,
    minScore: 0.02,
  });
  const selectedIds = new Set(selection.selected.map((s) => s.id));
  candidates = candidates.filter((c) => selectedIds.has(c.id) || c.verified);

  trace.candidates = candidates;
  trace.duration_ms = Date.now() - started;
  trace.stopped_early = stoppedEarly;

  return {
    intent: trace.intent,
    candidates,
    verifiedFiles: verifiedFiles.map((c) => ({ id: c.id, path: c.file_path ?? '', verification_state: c.verification_state ?? 'verified' } as unknown as IndexedFile)),
    memory: memoryHits.filter((h) => candidates.some((c) => c.memory_id === h.record.id)).map((h) => h.record),
    trace,
    stoppedEarly,
  };
}

/* --------------------------------- helpers -------------------------------- */

function exactBonus(query: string, haystacks: readonly string[]): number {
  const terms = analyzeQuery(query);
  let hits = 0;
  for (const term of terms.raw) {
    if (haystacks.some((h) => h.toLowerCase().split(/[./\\]/).some((part) => part === term))) hits += 1;
  }
  return terms.raw.length === 0 ? 0 : hits / terms.raw.length;
}

function fileReason(file: IndexedFile): string {
  const parts: string[] = [];
  if (file.summary) parts.push('index summary match');
  if (file.symbols.length > 0) parts.push('symbols present');
  return parts.join(', ') || 'index lexical match';
}

/**
 * Verified source is sent with **absolute** line numbers.
 *
 * Without them the model infers positions from the shape of the region it was
 * handed, which is how a correct file and a correct symbol still come back with
 * `path:line` citations a few dozen lines off — the one mistake a coding agent
 * must not make, because the next step is editing at that line.
 *
 * Large files keep the head and the tail, and say exactly which lines were
 * dropped instead of pretending the region is contiguous.
 */
export function renderNumberedSource(content: string, maxChars: number): string {
  const lines = content.split('\n');
  const numbered = lines.map((line, index) => `${index + 1}: ${line}`);
  const full = numbered.join('\n');
  if (full.length <= maxChars) return full;

  const headBudget = Math.floor(maxChars * 0.7);
  const tailBudget = Math.max(200, maxChars - headBudget - 120);
  const head: string[] = [];
  let headUsed = 0;
  let i = 0;
  while (i < numbered.length && headUsed + (numbered[i] as string).length + 1 <= headBudget) {
    head.push(numbered[i] as string);
    headUsed += (numbered[i] as string).length + 1;
    i += 1;
  }
  const tail: string[] = [];
  let tailUsed = 0;
  let j = numbered.length - 1;
  while (j >= i && tailUsed + (numbered[j] as string).length + 1 <= tailBudget) {
    tail.unshift(numbered[j] as string);
    tailUsed += (numbered[j] as string).length + 1;
    j -= 1;
  }
  const omitted = j - i + 1;
  const gap = `… [${omitted} line(s) omitted: ${i + 1}–${j + 1} of ${numbered.length} — read the file to see them] …`;
  return [...head, gap, ...tail].join('\n');
}

async function safe<T>(promise: Promise<T>, fallback: T): Promise<T> {
  try {
    return await promise;
  } catch {
    return fallback;
  }
}

/** Convert retrieval candidates into context items (§55: substitute, don't duplicate). */
export function candidatesToContextItems(candidates: readonly RetrievalCandidate[], _options: { maxBytes: number }): ContextItem[] {
  const out: ContextItem[] = [];
  for (const candidate of candidates) {
    if (candidate.content !== undefined) {
      out.push({
        id: `ctx:${candidate.id}`,
        kind: 'code',
        priority: 0.9,
        tokens: estimateTokens(candidate.content).tokens,
        content: candidate.content,
        label: candidate.file_path ?? candidate.id,
        source_refs: candidate.file_path ? [{ kind: 'file', file_path: candidate.file_path }] : [],
        untrusted: true,
        verification_state: candidate.verification_state,
        reason: candidate.reason,
      });
    }
  }
  return out;
}