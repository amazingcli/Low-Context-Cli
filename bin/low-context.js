#!/usr/bin/env node
/**
 * Low Context launcher.
 *
 * The CLI is written in TypeScript and compiled to `dist/`. This shim exists so
 * `low-context` works after `npm run build` (or `./install.sh`) without wiring a
 * per-platform binary.
 *
 * One guard lives here rather than in the CLI: when the user's shell is sitting
 * in a directory that has been deleted (a very common way to end up with
 * `ENOENT ... uv_cwd` on Node 18), every process that calls `process.cwd()`
 * crashes before it can print anything useful. Falling back to the home
 * directory turns that into a normal, working session.
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

try {
  process.cwd();
} catch {
  // The working directory no longer exists. `process.chdir` still works and
  // lands the process somewhere valid.
  process.chdir(homedir());
}

const here = dirname(fileURLToPath(import.meta.url));
const entry = join(here, '..', 'dist', 'src', 'cli', 'index.js');

if (!existsSync(entry)) {
  process.stderr.write(
    'Low Context has not been built yet.\n' +
      'Run one of:\n' +
      '  npm run build\n' +
      '  ./install.sh\n',
  );
  process.exit(78);
}

const mod = await import(entry);
await mod.main(process.argv.slice(2));
