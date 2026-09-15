#!/usr/bin/env node
/**
 * Low Context launcher.
 *
 * The CLI is written in TypeScript and compiled to `dist/`. This shim exists so
 * `low-context` works after `npm run build` (or `./install.sh`) without wiring a
 * per-platform binary.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

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
