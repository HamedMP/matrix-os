#!/usr/bin/env node
// Architecture budget gate for issue #1676 (Phase 0).
//
// Enforces three ratchets so structural debt can only shrink:
//   1. ratchets:   pinned files must not grow past their recorded line count.
//   2. fileCap:    any non-test source file over `fileCap` lines must be on
//                  the allowlist with a linked extraction issue.
//   3. dirCaps:    flat *.ts roots must not gain files.
//
// Config lives in scripts/review/arch-budgets.json. Values only ever move
// down, except when a split lands (then entries are pruned/updated in the
// same PR that shrinks the file).
import { readdir, readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = join(fileURLToPath(import.meta.url), '..');
const DEFAULT_CONFIG = join(SCRIPT_DIR, 'arch-budgets.json');
const DEFAULT_ROOT = resolve(SCRIPT_DIR, '..', '..');

const SOURCE_EXT = new Set(['.ts', '.tsx']);
const SKIP_DIRS = new Set(['node_modules', 'dist']);
// Test-support data, not shipped architecture: large stub servers and
// recorded payloads used only to exercise tests.
const SKIP_ANYWHERE = new Set(['fixtures', '__fixtures__']);
// Findings arrays are capped so a pathological tree cannot grow memory
// without bound; overflow is reported via `suppressed` counts.
const MAX_REPORTED_FINDINGS = 100;

function fail(name, message) {
  throw new Error(`[check-budgets] ${name} ${message}`);
}

function validateRoot(root) {
  if (typeof root !== 'string' || root.length === 0 || root.includes('\0')) {
    fail('root', 'must be a non-empty path string.');
  }
  if (root.split('/').includes('..') || root.split('\\').includes('..')) {
    fail('root', 'must not contain traversal segments.');
  }
  const abs = resolve(root);
  if (abs.split(sep).includes('..')) {
    fail('root', 'must not contain traversal segments.');
  }
  return abs;
}

function validateConfig(config) {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    fail('config', 'must be an object.');
  }
  const { fileCap, ratchets = {}, dirCaps = {}, allowlist = {} } = config;
  if (!Number.isInteger(fileCap) || fileCap <= 0) {
    fail('config.fileCap', 'must be a positive integer.');
  }
  for (const [section, values] of [['ratchets', ratchets], ['dirCaps', dirCaps]]) {
    if (values === null || typeof values !== 'object' || Array.isArray(values)) {
      fail(`config.${section}`, 'must be an object.');
    }
    for (const [rel, max] of Object.entries(values)) {
      assertRelPath(section, rel);
      if (!Number.isInteger(max) || max < 0) {
        fail(`config.${section}[${rel}]`, 'must be a non-negative integer.');
      }
    }
  }
  if (allowlist === null || typeof allowlist !== 'object' || Array.isArray(allowlist)) {
    fail('config.allowlist', 'must be an object.');
  }
  for (const [rel, entry] of Object.entries(allowlist)) {
    assertRelPath('allowlist', rel);
    if (entry === null || typeof entry !== 'object'
      || typeof entry.issue !== 'string' || entry.issue.length === 0
      || typeof entry.note !== 'string' || entry.note.length === 0) {
      fail(`config.allowlist[${rel}]`, 'must be an object with non-empty issue and note strings.');
    }
  }
  return { fileCap, ratchets, dirCaps, allowlist };
}

function assertRelPath(section, rel) {
  if (typeof rel !== 'string' || rel.length === 0 || rel.includes('\0')) {
    fail(`config.${section}`, 'keys must be non-empty path strings.');
  }
  if (isAbsolute(rel) || rel.split('/').includes('..')) {
    fail(`config.${section}[${rel}]`, 'must be a repo-relative path without traversal.');
  }
}

function countLines(content) {
  if (content.length === 0) return 0;
  const parts = content.split('\n');
  return content.endsWith('\n') ? parts.length - 1 : parts.length;
}

function isTestFile(fileName) {
  return fileName.endsWith('.test.ts') || fileName.endsWith('.test.tsx')
    || fileName.endsWith('.spec.ts') || fileName.endsWith('.spec.tsx');
}

function isDeclarationFile(fileName) {
  return fileName.endsWith('.d.ts') || fileName.endsWith('.d.tsx') || fileName.endsWith('.d.mts');
}

function extOf(fileName) {
  const dot = fileName.lastIndexOf('.');
  return dot === -1 ? '' : fileName.slice(dot);
}

function isScannedSource(fileName) {
  return SOURCE_EXT.has(extOf(fileName)) && !isTestFile(fileName) && !isDeclarationFile(fileName);
}

async function walkSources(root, onFile) {
  // Incremental: each source file is handed to onFile immediately, so no
  // per-file state accumulates. The stack holds one entry per directory
  // depth level; readdir listings are transient per directory.
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return;
      throw err;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory() && SKIP_ANYWHERE.has(entry.name)) continue;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) stack.push(abs);
      } else if (entry.isFile() && isScannedSource(entry.name)) {
        await onFile(relative(root, abs).split(sep).join('/'), abs);
      }
    }
  }
}

async function readLineCount(abs) {
  try {
    return countLines(await readFile(abs, 'utf8'));
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
}

async function flatTsCount(dirAbs) {
  let entries;
  try {
    entries = await readdir(dirAbs, { withFileTypes: true });
  } catch (err) {
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return null;
    throw err;
  }
  let count = 0;
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink()) continue;
    if ((entry.name.endsWith('.ts') || entry.name.endsWith('.tsx'))
      && !isTestFile(entry.name) && !isDeclarationFile(entry.name)) {
      count += 1;
    }
  }
  return count;
}

function makeFindings() {
  return { items: [], suppressed: 0 };
}

function report(findings, item) {
  if (findings.items.length < MAX_REPORTED_FINDINGS) {
    findings.items.push(item);
  } else {
    findings.suppressed += 1;
  }
}

export async function checkBudgets({ root, config }) {
  const absRoot = validateRoot(root);
  let rootStat;
  try {
    rootStat = await stat(absRoot);
  } catch (err) {
    if (err?.code === 'ENOENT') fail('root', `not found: ${absRoot}`);
    throw err;
  }
  if (!rootStat.isDirectory()) {
    fail('root', `not a directory: ${absRoot}`);
  }
  const { fileCap, ratchets, dirCaps, allowlist } = validateConfig(config);
  const violations = makeFindings();
  const warnings = makeFindings();

  // Ratchet observations are keyed by config entry, so retained state is
  // bounded by the config file — not by tree size.
  const ratchetSeen = Object.create(null);
  await walkSources(absRoot, async (rel, abs) => {
    const actual = await readLineCount(abs);
    if (actual === null) return;
    if (Object.hasOwn(ratchets, rel)) {
      ratchetSeen[rel] = actual;
    }
    if (actual <= fileCap) return;
    if (Object.hasOwn(allowlist, rel)) {
      report(warnings, { kind: 'allowlisted', path: rel, actual, cap: fileCap, issue: allowlist[rel].issue });
    } else {
      report(violations, { kind: 'file-cap', path: rel, actual, max: fileCap });
    }
  });

  for (const [rel, max] of Object.entries(ratchets)) {
    if (Object.hasOwn(ratchetSeen, rel)) {
      const actual = ratchetSeen[rel];
      if (actual > max) {
        report(violations, { kind: 'ratchet', path: rel, actual, max });
      }
      continue;
    }
    const actual = await readLineCount(join(absRoot, rel.split('/').join(sep)));
    if (actual === null) {
      report(warnings, { kind: 'stale-ratchet', path: rel, note: 'file missing; prune this entry' });
    } else if (actual > max) {
      report(violations, { kind: 'ratchet', path: rel, actual, max });
    }
  }

  for (const [rel, max] of Object.entries(dirCaps)) {
    const actual = await flatTsCount(join(absRoot, rel.split('/').join(sep)));
    if (actual === null) {
      report(warnings, { kind: 'stale-dir-cap', path: rel, note: 'directory missing; prune this entry' });
    } else if (actual > max) {
      report(violations, { kind: 'dir-cap', path: rel, actual, max });
    }
  }

  return {
    violations: violations.items,
    warnings: warnings.items,
    suppressed: { violations: violations.suppressed, warnings: warnings.suppressed },
  };
}

function parseArgs(argv) {
  const out = { config: DEFAULT_CONFIG, root: DEFAULT_ROOT };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--config' && typeof argv[i + 1] === 'string') {
      out.config = argv[i + 1];
      i += 1;
    } else if (argv[i] === '--root' && typeof argv[i + 1] === 'string') {
      out.root = argv[i + 1];
      i += 1;
    } else {
      fail('args', `unknown argument: ${argv[i]} (usage: --config <path> --root <path>)`);
    }
  }
  return out;
}

async function main() {
  const { config: configPath, root } = parseArgs(process.argv.slice(2));
  const absConfig = validateRoot(configPath);
  let config;
  try {
    config = JSON.parse(await readFile(absConfig, 'utf8'));
  } catch (err) {
    if (err?.code === 'ENOENT') fail('config', `not found: ${absConfig}`);
    throw err;
  }
  const { violations, warnings, suppressed } = await checkBudgets({ root, config });
  for (const w of warnings) {
    console.log(`WARNING [${w.kind}] ${w.path}${w.actual !== undefined ? ` (${w.actual} lines)` : ''}${w.issue ? ` ${w.issue}` : ''}`);
  }
  for (const v of violations) {
    console.log(`VIOLATION [${v.kind}] ${v.path}: ${v.actual} > ${v.max}`);
  }
  if (suppressed.violations > 0 || suppressed.warnings > 0) {
    console.log(`(+${suppressed.violations} violation(s), +${suppressed.warnings} warning(s) suppressed past report cap)`);
  }
  if (violations.length > 0) {
    console.log(`FAIL: ${violations.length} budget violation(s), ${warnings.length} warning(s)`);
    process.exitCode = 1;
  } else if (warnings.length > 0) {
    console.log(`WARN: ${warnings.length} warning(s), 0 violations`);
  } else {
    console.log('PASS: all architecture budgets hold');
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 2;
  });
}
