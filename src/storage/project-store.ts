/**
 * Project registry (§26, §83).
 *
 * A small JSON registry of every project Low Context has opened, keyed by
 * canonical root path. This is what lets `session list` show sessions from a
 * project you are no longer standing in, and what ties memory scopes to a
 * stable `project_id` instead of a mutable directory name.
 */
import { join } from 'node:path';
import { globalPaths } from '../core/paths.js';
import { atomicWrite, nowIso, readJsonIfExists } from '../core/util.js';
import { newId } from '../core/ids.js';
import type { ProjectRecord } from '../core/types.js';
import type { ProjectStore } from './interfaces.js';
import { sha256 } from '../core/util.js';

interface RegistryFile {
  version: 1;
  projects: ProjectRecord[];
}

/** Stable id for a project root, so ids survive a registry reset. */
export function projectIdForRoot(root: string): string {
  return `project_${sha256(root).slice(0, 16)}`;
}

export class FileProjectStore implements ProjectStore {
  private readonly path: string;
  private cache: RegistryFile | undefined;

  constructor(dir = globalPaths().projects) {
    this.path = join(dir, 'registry.json');
  }

  private async load(): Promise<RegistryFile> {
    if (this.cache) return this.cache;
    const data = await readJsonIfExists<RegistryFile>(this.path);
    this.cache = data && Array.isArray(data.projects) ? data : { version: 1, projects: [] };
    return this.cache;
  }

  private async save(): Promise<void> {
    if (!this.cache) return;
    await atomicWrite(this.path, `${JSON.stringify(this.cache, null, 2)}\n`);
  }

  async upsert(project: ProjectRecord): Promise<void> {
    const registry = await this.load();
    const index = registry.projects.findIndex((p) => p.id === project.id);
    if (index >= 0) registry.projects[index] = { ...registry.projects[index], ...project };
    else registry.projects.push(project);
    await this.save();
  }

  async get(id: string): Promise<ProjectRecord | undefined> {
    const registry = await this.load();
    return registry.projects.find((p) => p.id === id);
  }

  async findByRoot(root: string): Promise<ProjectRecord | undefined> {
    const registry = await this.load();
    const wanted = projectIdForRoot(root);
    return registry.projects.find((p) => p.id === wanted || p.root === root);
  }

  /** Register (or refresh) a project, returning the stored record. */
  async ensure(root: string, name?: string): Promise<ProjectRecord> {
    const existing = await this.findByRoot(root);
    const now = nowIso();
    if (existing) {
      existing.last_opened_at = now;
      if (name) existing.name = name;
      await this.save();
      return existing;
    }
    const record: ProjectRecord = {
      id: projectIdForRoot(root),
      name: name ?? root.split('/').filter(Boolean).pop() ?? 'project',
      root,
      created_at: now,
      last_opened_at: now,
    };
    // `newId` is not used here on purpose: the id must be stable across
    // machines and registry rebuilds, so it is derived from the root path.
    void newId;
    await this.upsert(record);
    return record;
  }

  async list(): Promise<ProjectRecord[]> {
    const registry = await this.load();
    return [...registry.projects].sort((a, b) => b.last_opened_at.localeCompare(a.last_opened_at));
  }

  async remove(id: string): Promise<boolean> {
    const registry = await this.load();
    const before = registry.projects.length;
    registry.projects = registry.projects.filter((p) => p.id !== id);
    await this.save();
    return registry.projects.length !== before;
  }

  async touch(id: string): Promise<void> {
    const registry = await this.load();
    const project = registry.projects.find((p) => p.id === id);
    if (!project) return;
    project.last_opened_at = nowIso();
    await this.save();
  }
}
