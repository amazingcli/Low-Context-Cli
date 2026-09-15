/**
 * Sessions (§27).
 *
 * A session is the unit a user resumes. Crucially, resuming must **not** replay
 * the raw conversation: the session carries a compact `TaskState` (goal,
 * decisions, pending work, relevant files) plus its conversation id, and the
 * agent rebuilds context through retrieval (§27, §64).
 */
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { ensureDir, nowIso, atomicWrite, readJsonIfExists } from '../core/util.js';
import { newId } from '../core/ids.js';
import type { Session, TaskState } from '../core/types.js';
import type { SessionStore } from './interfaces.js';

export class FileSessionStore implements SessionStore {
  private readonly dir: string;
  private cache = new Map<string, Session>();

  constructor(baseDir: string) {
    this.dir = join(baseDir, 'sessions');
  }

  private path(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  private async save(session: Session): Promise<void> {
    this.cache.set(session.id, session);
    await atomicWrite(this.path(session.id), `${JSON.stringify(session, null, 2)}\n`);
  }

  async create(input: {
    project_id?: string;
    project_root?: string;
    conversation_id?: string;
    task_id?: string;
    title?: string;
    provider?: string;
    model?: string;
  }): Promise<Session> {
    await ensureDir(this.dir);
    const now = nowIso();
    const session: Session = {
      id: newId('ses'),
      created_at: now,
      updated_at: now,
      status: 'active',
      message_count: 0,
    };
    if (input.project_id !== undefined) session.project_id = input.project_id;
    if (input.project_root !== undefined) session.project_root = input.project_root;
    if (input.conversation_id !== undefined) session.conversation_id = input.conversation_id;
    if (input.task_id !== undefined) session.task_id = input.task_id;
    if (input.title !== undefined) session.title = input.title;
    if (input.provider !== undefined) session.provider = input.provider;
    if (input.model !== undefined) session.model = input.model;
    await this.save(session);
    return session;
  }

  async get(id: string): Promise<Session | undefined> {
    const cached = this.cache.get(id);
    if (cached) return cached;
    const session = await readJsonIfExists<Session>(this.path(id));
    if (session) {
      if (!session.status) session.status = 'idle';
      this.cache.set(id, session);
    }
    return session;
  }

  async resolve(idOrPrefix: string): Promise<Session | undefined> {
    const exact = await this.get(idOrPrefix);
    if (exact) return exact;
    const matches = (await this.list({ limit: 500 })).filter((s) => s.id.startsWith(idOrPrefix));
    if (matches.length === 1) return matches[0];
    return undefined;
  }

  async list(input: { project_id?: string; limit?: number; status?: Session['status'] } = {}): Promise<Session[]> {
    await ensureDir(this.dir);
    const entries = await readdir(this.dir).catch(() => [] as string[]);
    const out: Session[] = [];
    for (const name of entries) {
      if (!name.endsWith('.json')) continue;
      const id = name.slice(0, -'.json'.length);
      const session = await this.get(id);
      if (!session) continue;
      if (input.project_id && session.project_id !== input.project_id) continue;
      if (input.status && session.status !== input.status) continue;
      out.push(session);
    }
    out.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    return input.limit ? out.slice(0, input.limit) : out;
  }

  async update(id: string, patch: Partial<Session>): Promise<Session | undefined> {
    const session = await this.get(id);
    if (!session) return undefined;
    const merged: Session = { ...session, ...patch, id: session.id, updated_at: nowIso() };
    await this.save(merged);
    return merged;
  }

  async saveTaskState(id: string, state: TaskState): Promise<void> {
    const session = await this.get(id);
    if (!session) return;
    session.task_state = state;
    session.task_id = state.id;
    session.updated_at = nowIso();
    await this.save(session);
  }

  async end(id: string): Promise<void> {
    const session = await this.get(id);
    if (!session) return;
    session.status = 'ended';
    session.ended_at = nowIso();
    session.updated_at = session.ended_at;
    await this.save(session);
  }

  async delete(id: string): Promise<boolean> {
    const existed = (await this.get(id)) !== undefined;
    this.cache.delete(id);
    await rm(this.path(id), { force: true });
    return existed;
  }

  async latest(projectId?: string): Promise<Session | undefined> {
    const sessions = await this.list({ ...(projectId === undefined ? {} : { project_id: projectId }), limit: 1 });
    return sessions[0];
  }

  /** Mark sessions interrupted by a crash as idle rather than active. */
  async reconcile(): Promise<number> {
    let changed = 0;
    for (const session of await this.list({})) {
      if (session.status === 'active') {
        session.status = 'idle';
        await this.save(session);
        changed += 1;
      }
    }
    return changed;
  }
}
