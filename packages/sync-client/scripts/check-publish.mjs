#!/usr/bin/env node
// Guard that runs before `npm publish`. Verifies the package has the files
// it claims to ship — the bin entry and the CLI source tree.
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');

const mustExist = [
  'bin/matrix.mjs',
  'src/cli/index.ts',
  'src/daemon/index.ts',
  'src/index.ts',
];

const missing = mustExist.filter((p) => !existsSync(resolve(pkgRoot, p)));
if (missing.length > 0) {
  console.error('Pre-publish check failed. Missing required files:');
  for (const p of missing) console.error(`  - ${p}`);
  process.exit(1);
}

console.log('Pre-publish check: ok.');
