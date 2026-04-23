// Shared tsx loader finder. Both bin/matrixos.mjs (monorepo root) and
// packages/sync-client/bin/matrix.mjs (published package) import this to
// avoid duplicating the bounded-walk logic.
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';

export function findTsxLoader(start) {
  let dir = start;
  for (let i = 0; i < 6; i += 1) {
    const candidate = resolve(dir, 'node_modules', 'tsx', 'dist', 'loader.mjs');
    if (existsSync(candidate)) return candidate;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}
