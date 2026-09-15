/**
 * Secret handling.
 *
 * API keys are read from environment variables first (§25: "use environment
 * variables or secure credential storage where available"), and only fall back
 * to a credentials file written with mode 0600. Secrets are never logged, never
 * echoed back, and never included in memory records (§46, §80).
 */
import { readFile } from 'node:fs/promises';
import { chmodSync } from 'node:fs';
import { globalPaths } from '../core/paths.js';
import { atomicWrite, safeJsonParse } from '../core/util.js';

export type CredentialMap = Record<string, string>;

const cache = new Map<string, string | undefined>();

export function credentialsPath(): string {
  return globalPaths().credentials;
}

/** Read the on-disk credential map. Returns `{}` when absent or unreadable. */
export async function loadCredentials(): Promise<CredentialMap> {
  try {
    const text = await readFile(credentialsPath(), 'utf8');
    const parsed = safeJsonParse<CredentialMap>(text);
    if (!parsed.ok || typeof parsed.value !== 'object' || parsed.value === null) return {};
    const out: CredentialMap = {};
    for (const [key, value] of Object.entries(parsed.value)) {
      if (typeof value === 'string' && value !== '') out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

export async function saveCredentials(map: CredentialMap): Promise<void> {
  const path = credentialsPath();
  await atomicWrite(path, `${JSON.stringify(map, null, 2)}\n`, 0o600);
  try {
    chmodSync(path, 0o600);
  } catch {
    // Best effort: some filesystems (Windows) do not support POSIX modes.
  }
  cache.clear();
}

export async function setCredential(ref: string, value: string): Promise<void> {
  const map = await loadCredentials();
  if (value === '') delete map[ref];
  else map[ref] = value;
  await saveCredentials(map);
}

export async function deleteCredential(ref: string): Promise<boolean> {
  const map = await loadCredentials();
  if (!(ref in map)) return false;
  delete map[ref];
  await saveCredentials(map);
  return true;
}

/**
 * Resolve a credential. `envNames` are checked first so CI/containers can
 * inject keys without touching disk.
 */
export async function resolveSecret(ref: string | undefined, envNames: readonly string[] = []): Promise<string | undefined> {
  for (const name of envNames) {
    const value = process.env[name];
    if (value && value.trim() !== '') return value.trim();
  }
  if (!ref) return undefined;
  const cacheKey = `ref:${ref}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);
  const map = await loadCredentials();
  const value = map[ref];
  cache.set(cacheKey, value);
  return value;
}

export function clearSecretCache(): void {
  cache.clear();
}

/** Report whether a secret exists without revealing any of its characters. */
export function maskSecret(value: string | undefined): string {
  if (!value) return '(not set)';
  if (value.length <= 8) return `${'*'.repeat(value.length)} (${value.length} chars)`;
  return `${value.slice(0, 3)}…${value.slice(-2)} (${value.length} chars)`;
}

/**
 * Environment variables that must never be forwarded into a child process or
 * into model context.
 */
export const SENSITIVE_ENV_PATTERN =
  /(API[_-]?KEY|SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE[_-]?KEY|CREDENTIAL|SESSION[_-]?ID|AUTH|COOKIE|ACCESS[_-]?KEY|CLIENT[_-]?SECRET)/i;

export function isSensitiveEnvName(name: string): boolean {
  return SENSITIVE_ENV_PATTERN.test(name);
}
