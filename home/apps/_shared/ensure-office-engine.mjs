#!/usr/bin/env node
// Runs before an office app builds (its package.json `build` and `dev`).
//
// `./office-engine/` is a generated, git-ignored copy of packages/office/src.
// In a Matrix OS checkout this regenerates it (a no-op when up to date). On an
// owner's computer the repository is absent: the copy arrived with the home
// template, so it is used as is and only its presence is checked.

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const shared = dirname(fileURLToPath(import.meta.url));
const mirror = join(shared, 'office-engine');
// home/apps/_shared -> repository root, when this file is inside a checkout.
const repository = join(shared, '..', '..', '..');
const syncScript = join(repository, 'scripts', 'sync-office-engine.mjs');

if (existsSync(syncScript) && existsSync(join(repository, 'packages', 'office', 'src'))) {
  const { syncOfficeEngine } = await import(pathToFileURL(syncScript).href);
  const { changes } = syncOfficeEngine({ root: repository });
  if (changes.length > 0) console.log(`[office-engine] regenerated ${changes.length} file(s) in ${mirror}`);
}

if (!existsSync(join(mirror, 'index.ts'))) {
  console.error(
    `[office-engine] ${mirror} is missing. In a Matrix OS checkout run: node scripts/sync-office-engine.mjs`,
  );
  process.exit(1);
}
