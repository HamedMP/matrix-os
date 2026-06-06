#!/usr/bin/env node
// Guard that runs before `npm publish`. Verifies the package has the files
// it claims to ship — the bin entry and the CLI source tree.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');

const mustExist = [
  'bin/matrix.mjs',
  'src/cli/index.ts',
  'src/daemon/index.ts',
  'src/index.ts',
  'src/lib/find-tsx-loader.mjs',
  'src/lib/node-runtime-guard.mjs',
];

const missing = mustExist.filter((p) => !existsSync(resolve(pkgRoot, p)));
if (missing.length > 0) {
  console.error('Pre-publish check failed. Missing required files:');
  for (const p of missing) console.error(`  - ${p}`);
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(resolve(pkgRoot, 'package.json'), 'utf8'));
const binTargets = Object.entries(pkg.bin ?? {});
const missingBins = ['matrix', 'matrixos', 'mos'].filter((name) => pkg.bin?.[name] !== 'bin/matrix.mjs');
if (missingBins.length > 0) {
  console.error('Pre-publish check failed. Missing package-runner bin aliases:');
  for (const name of missingBins) console.error(`  - ${name}`);
  process.exit(1);
}
if (binTargets.length !== 3) {
  console.error('Pre-publish check failed. Unexpected bin aliases in package.json.');
  process.exit(1);
}
if (!Array.isArray(pkg.files) || !pkg.files.includes('bin/') || !pkg.files.includes('src/')) {
  console.error('Pre-publish check failed. package.json files must include bin/ and src/.');
  process.exit(1);
}

console.log('Pre-publish check: ok.');
