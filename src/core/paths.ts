/**
 * Where Low Context keeps its state.
 *
 * Global state lives under `$LOW_CONTEXT_HOME` or `~/.low-context` (§25).
 * Per-project state lives under `<project>/.low-context` (§26) and can be
 * disabled in favour of centralised storage.
 */
import { homedir } from 'node:os';
import { isAbsolute, join, normalize, resolve } from 'node:path';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';

export interface GlobalPaths {
  home: string;
  config: string;
  providers: string;
  models: string;
  credentials: string;
  memory: string;
  indexes: string;
  projects: string;
  sessions: string;
  logs: string;
  cache: string;
  artifacts: string;
}

export interface ProjectPaths {
  root: string;
  dir: string;
  project_file: string;
  index: string;
  memory: string;
  sessions: string;
  cache: string;
}

export function globalHome(): string {
  const override = process.env.LOW_CONTEXT_HOME;
  if (override && override.trim() !== '') return resolve(override);
  return join(homedir(), '.low-context');
}

export function globalPaths(): GlobalPaths {
  const home = globalHome();
  return {
    home,
    config: join(home, 'config'),
    providers: join(home, 'config', 'providers'),
    models: join(home, 'config', 'models'),
    credentials: join(home, 'config', 'credentials.json'),
    memory: join(home, 'memory'),
    indexes: join(home, 'indexes'),
    projects: join(home, 'projects'),
    sessions: join(home, 'sessions'),
    logs: join(home, 'logs'),
    cache: join(home, 'cache'),
    artifacts: join(home, 'artifacts'),
  };
}

export function projectPaths(root: string, opts: { local: boolean } = { local: true }): ProjectPaths {
  const base = resolve(root);
  if (!opts.local) {
    // Centralised storage keyed by a stable hash of the root path.
    const key = resolve(base).replace(/[^a-zA-Z0-9]+/g, '_').slice(-120);
    const dir = join(globalPaths().projects, key);
    return {
      root: base,
      dir,
      project_file: join(dir, 'project.json'),
      index: join(dir, 'index'),
      memory: join(dir, 'memory'),
      sessions: join(dir, 'sessions'),
      cache: join(dir, 'cache'),
    };
  }
  const dir = join(base, '.low-context');
  return {
    root: base,
    dir,
    project_file: join(dir, 'project.json'),
    index: join(dir, 'index'),
    memory: join(dir, 'memory'),
    sessions: join(dir, 'sessions'),
    cache: join(dir, 'cache'),
  };
}

/** Directories that are never part of a project's readable source. */
export const NEVER_INDEX = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  'dist',
  'build',
  'out',
  'target',
  'vendor',
  '__pycache__',
  '.venv',
  'venv',
  '.mypy_cache',
  '.pytest_cache',
  '.ruff_cache',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  '.idea',
  '.vscode',
  'coverage',
  '.low-context',
  '.terraform',
  '.gradle',
  '.DS_Store',
]);

/**
 * Walk upwards looking for a project root: a `.git` directory, a
 * `.low-context` directory, or a manifest file.
 */
export async function findProjectRoot(start = process.cwd(), stopAt?: string): Promise<string> {
  let current = resolve(start);
  const stop = stopAt ? resolve(stopAt) : undefined;
  const manifestMarkers = [
    'package.json',
    'pyproject.toml',
    'go.mod',
    'Cargo.toml',
    'composer.json',
    'Gemfile',
    'pom.xml',
    'build.gradle',
  ];

  // eslint-disable-next-line no-constant-condition
  while (true) {
    for (const marker of ['.git', '.low-context']) {
      if (await exists(join(current, marker))) return current;
    }
    for (const marker of manifestMarkers) {
      if (await exists(join(current, marker))) return current;
    }
    const parent = resolve(current, '..');
    if (parent === current) return resolve(start);
    if (stop && current === stop) return resolve(start);
    current = parent;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/** True when `child` is inside `parent` (after normalisation, no symlink follow). */
export function isInside(parent: string, child: string): boolean {
  const p = normalize(resolve(parent));
  const c = normalize(resolve(child));
  if (p === c) return true;
  return c.startsWith(p.endsWith('/') ? p : `${p}/`);
}

export function toPosix(path: string): string {
  return path.split('\\').join('/');
}

/** Project-relative POSIX path, or the absolute path when outside the root. */
export function relativePath(root: string, path: string): string {
  const rel = resolve(root) === resolve(path) ? '.' : resolve(path).slice(resolve(root).length + 1);
  return toPosix(isAbsolute(rel) ? path : rel);
}
