/**
 * Task memory storage (§4B).
 *
 * `TaskState` is intentionally small: goal, decisions, pending/completed work,
 * relevant files and symbols. It is the one thing that is *always* allowed into
 * active context, because it is what keeps a long task coherent after
 * compaction (§15).
 */
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { ensureDir, nowIso, atomicWrite, readJsonIfExists } from '../core/util.js';
import { newId } from '../core/ids.js';
import type { SourceReference, TaskDecision, TaskState } from '../core/types.js';
import type { TaskStore } from './interfaces.js';

export class FileTaskStore implements TaskStore {
  private readonly dir: string;
  private cache = new Map<string, TaskState>();

  constructor(baseDir: string) {
    this.dir = join(baseDir, 'tasks');
  }

  private path(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  async create(input: {
    title: string;
    goal?: string;
    project_id?: string;
    session_id?: string;
  }): Promise<TaskState> {
    const now = nowIso();
    const state: TaskState = {
      id: newId('task'),
      title: input.title,
      goal: input.goal ?? input.title,
      status: 'open',
      decisions: [],
      pending: [],
      completed: [],
      relevant_files: [],
      relevant_symbols: [],
      open_questions: [],
      created_at: now,
      updated_at: now,
    };
    if (input.project_id !== undefined) state.project_id = input.project_id;
    if (input.session_id !== undefined) state.session_id = input.session_id;
    await this.upsert(state);
    return state;
  }

  async upsert(state: TaskState): Promise<void> {
    await ensureDir(this.dir);
    const updated: TaskState = { ...state, updated_at: nowIso() };
    this.cache.set(updated.id, updated);
    await atomicWrite(this.path(updated.id), `${JSON.stringify(updated, null, 2)}\n`);
  }

  async get(id: string): Promise<TaskState | undefined> {
    const cached = this.cache.get(id);
    if (cached) return cached;
    const state = await readJsonIfExists<TaskState>(this.path(id));
    if (state) this.cache.set(id, state);
    return state;
  }

  async active(sessionId: string): Promise<TaskState | undefined> {
    const all = await this.list({});
    return all.find((task) => task.session_id === sessionId && task.status !== 'done' && task.status !== 'abandoned');
  }

  async list(input: { project_id?: string; limit?: number } = {}): Promise<TaskState[]> {
    await ensureDir(this.dir);
    const entries = await readdir(this.dir).catch(() => [] as string[]);
    const out: TaskState[] = [];
    for (const name of entries) {
      if (!name.endsWith('.json')) continue;
      const state = await this.get(name.slice(0, -'.json'.length));
      if (!state) continue;
      if (input.project_id && state.project_id !== input.project_id) continue;
      out.push(state);
    }
    out.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    return input.limit ? out.slice(0, input.limit) : out;
  }

  async delete(id: string): Promise<boolean> {
    const existed = (await this.get(id)) !== undefined;
    this.cache.delete(id);
    await rm(this.path(id), { force: true });
    return existed;
  }
}

/* ------------------------------ state mutation ----------------------------- */

/** Add a decision while keeping provenance, and de-duplicating repeats. */
export function recordDecision(
  state: TaskState,
  input: { statement: string; rationale?: string; source_refs?: SourceReference[]; memory_id?: string },
): TaskDecision {
  const existing = state.decisions.find((d) => d.statement === input.statement);
  if (existing) return existing;
  const decision: TaskDecision = {
    id: newId('dec'),
    statement: input.statement,
    made_at: nowIso(),
    source_refs: input.source_refs ?? [],
  };
  if (input.rationale !== undefined) decision.rationale = input.rationale;
  if (input.memory_id !== undefined) decision.memory_id = input.memory_id;
  state.decisions.push(decision);
  state.updated_at = nowIso();
  return decision;
}

export function addPending(state: TaskState, item: string): void {
  if (!state.pending.includes(item)) state.pending.push(item);
  state.completed = state.completed.filter((c) => c !== item);
  state.updated_at = nowIso();
}

export function completePending(state: TaskState, item: string): void {
  state.pending = state.pending.filter((p) => p !== item);
  if (!state.completed.includes(item)) state.completed.push(item);
  state.updated_at = nowIso();
}

export function trackFile(state: TaskState, path: string, limit = 24): void {
  state.relevant_files = [path, ...state.relevant_files.filter((f) => f !== path)].slice(0, limit);
  state.updated_at = nowIso();
}

export function trackSymbol(state: TaskState, symbol: string, limit = 32): void {
  state.relevant_symbols = [symbol, ...state.relevant_symbols.filter((s) => s !== symbol)].slice(0, limit);
  state.updated_at = nowIso();
}

/**
 * Render task state as compact text for the context builder. Deliberately
 * terse: task state is always present, so it must earn its tokens (§4B).
 */
export function renderTaskState(state: TaskState): string {
  const lines: string[] = [];
  lines.push(`Task: ${state.title}`);
  if (state.goal && state.goal !== state.title) lines.push(`Goal: ${state.goal}`);
  lines.push(`Status: ${state.status}`);
  if (state.decisions.length > 0) {
    lines.push('Decisions:');
    for (const decision of state.decisions.slice(-5)) lines.push(`- ${decision.statement}`);
  }
  if (state.pending.length > 0) lines.push(`Pending: ${state.pending.join('; ')}`);
  if (state.completed.length > 0) lines.push(`Done: ${state.completed.slice(-5).join('; ')}`);
  if (state.relevant_files.length > 0) lines.push(`Files: ${state.relevant_files.slice(0, 10).join(', ')}`);
  if (state.relevant_symbols.length > 0) lines.push(`Symbols: ${state.relevant_symbols.slice(0, 12).join(', ')}`);
  if (state.open_questions.length > 0) lines.push(`Open questions: ${state.open_questions.join('; ')}`);
  return lines.join('\n');
}
