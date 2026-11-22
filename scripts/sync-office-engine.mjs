#!/usr/bin/env node
// Mirrors the @matrix-os/office source into the default apps' shared folder.
//
// Default apps are isolated pnpm projects that are rebuilt on the owner's
// machine, where packages/office does not exist, so they cannot depend on the
// workspace package. They import this verbatim copy by relative path instead.
//
//   node scripts/sync-office-engine.mjs           write the mirror
//   node scripts/sync-office-engine.mjs --check   exit 1 when the mirror is stale
//   --root <checkout>                             act on another checkout (tests)

import { lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const SOURCE_DIR = 'packages/office/src';
export const MIRROR_DIR = 'home/apps/_shared/office-engine';
export const NOTICE_FILE = 'README.md';

export const NOTICE = `<!-- GENERATED FILE. DO NOT EDIT ANYTHING IN THIS DIRECTORY. -->

# Office engine (generated mirror)

Every file here except this one is a byte-for-byte copy of \`${SOURCE_DIR}/\`
(the \`@matrix-os/office\` package). Default apps import it by relative path,
for example \`../../_shared/office-engine/index.js\`, because they are built
outside the workspace and cannot depend on the package.

- Change the engine in \`${SOURCE_DIR}/\`, never here.
- Then run \`node scripts/sync-office-engine.mjs\` and commit the result.
- \`tests/office/engine-mirror.test.ts\` fails while this copy is stale
  (\`node scripts/sync-office-engine.mjs --check\`).
`;

/** Relative paths (forward slashes) of every file under `directory`, sorted. */
function listFiles(directory, prefix = '') {
  let entries;
  try {
    entries = readdirSync(join(directory, prefix), { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const files = [];
  for (const entry of entries) {
    const relative = `${prefix}${entry.name}`;
    if (entry.isSymbolicLink()) {
      throw new Error(`Refusing to mirror a symbolic link: ${join(directory, relative)}`);
    }
    if (entry.isDirectory()) files.push(...listFiles(directory, `${relative}/`));
    else if (entry.isFile()) files.push(relative);
    else throw new Error(`Refusing to mirror a special file: ${join(directory, relative)}`);
  }
  return files.sort();
}

function readIfPresent(path) {
  try {
    return readFileSync(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

/** Removes `directory` and its parents up to (not including) `stop` while they are empty. */
function pruneEmptyDirectories(directory, stop) {
  let current = directory;
  while (current !== stop && current.startsWith(stop)) {
    try {
      rmdirSync(current);
    } catch (error) {
      if (error?.code === 'ENOTEMPTY' || error?.code === 'EEXIST' || error?.code === 'ENOENT') return;
      throw error;
    }
    current = dirname(current);
  }
}

/**
 * Brings the mirror in line with the source, or with `check` only reports
 * what would change.
 *
 * @param {{ root?: string, check?: boolean }} [options]
 * @returns {{ changes: { path: string, action: 'add' | 'update' | 'delete' }[] }}
 */
export function syncOfficeEngine({
  root = resolve(dirname(fileURLToPath(import.meta.url)), '..'),
  check = false,
} = {}) {
  const sourceRoot = join(root, SOURCE_DIR);
  const mirrorRoot = join(root, MIRROR_DIR);
  if (!lstatSync(sourceRoot, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`Engine source directory not found: ${SOURCE_DIR}`);
  }

  const wanted = new Map([[NOTICE_FILE, Buffer.from(NOTICE)]]);
  for (const path of listFiles(sourceRoot)) {
    if (path === NOTICE_FILE) {
      throw new Error(`${SOURCE_DIR}/${NOTICE_FILE} collides with the generated notice in the mirror`);
    }
    wanted.set(path, readFileSync(join(sourceRoot, path)));
  }

  const changes = [];
  for (const [path, content] of wanted) {
    const current = readIfPresent(join(mirrorRoot, path));
    if (current !== null && current.equals(content)) continue;
    changes.push({ path, action: current === null ? 'add' : 'update' });
    if (check) continue;
    mkdirSync(dirname(join(mirrorRoot, path)), { recursive: true });
    writeFileSync(join(mirrorRoot, path), content);
  }
  for (const path of listFiles(mirrorRoot)) {
    if (wanted.has(path)) continue;
    changes.push({ path, action: 'delete' });
    if (check) continue;
    rmSync(join(mirrorRoot, path));
    pruneEmptyDirectories(dirname(join(mirrorRoot, path)), mirrorRoot);
  }
  changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { changes };
}

function main(args) {
  let check = false;
  let root;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--check') check = true;
    else if (args[index] === '--root' && args[index + 1]) root = resolve(args[(index += 1)]);
    else {
      console.error('Usage: sync-office-engine.mjs [--check] [--root <checkout>]');
      return 2;
    }
  }
  const { changes } = syncOfficeEngine({ root, check });
  if (changes.length === 0) {
    console.log(`[sync-office-engine] ${MIRROR_DIR} is up to date`);
    return 0;
  }
  const report = changes.map(change => `  ${change.action.padEnd(6)} ${MIRROR_DIR}/${change.path}`).join('\n');
  if (check) {
    console.error(`[sync-office-engine] ${MIRROR_DIR} is stale. Run: node scripts/sync-office-engine.mjs\n${report}`);
    return 1;
  }
  console.log(`[sync-office-engine] updated ${changes.length} file(s)\n${report}`);
  return 0;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error('[sync-office-engine] Failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
