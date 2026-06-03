#!/usr/bin/env node
import { copyFile, lstat, mkdir, readdir, readFile, rename, unlink } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_MATRIX_HOME = '/home/matrix/home';
const DEFAULT_TEMPLATE_HOME = '/opt/matrix/app/home';
const ICON_EXTENSIONS = new Set(['.png', '.svg']);
const MAX_ICON_BYTES = 10 * 1024 * 1024;
const BACKUP_STAMP_PATTERN = /^\d{8}T\d{6}Z$/;

function utcStamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function isIconFileName(fileName) {
  return /^[a-z0-9][a-z0-9-]*\.(png|svg)$/.test(fileName);
}

function validateRootPath(name, path) {
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0') || path.split('/').includes('..')) {
    throw new Error(`${name} must be an absolute path without traversal segments`);
  }
  return path;
}

function validateBackupStamp(backupStamp) {
  if (typeof backupStamp !== 'string' || !BACKUP_STAMP_PATTERN.test(backupStamp)) {
    throw new Error('backupStamp must match YYYYMMDDTHHMMSSZ');
  }
  return backupStamp;
}

async function lstatOrNull(path) {
  try {
    return await lstat(path);
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
}

async function sameFileBytes(a, b) {
  const [left, right] = await Promise.all([readFile(a), readFile(b)]);
  return left.equals(right);
}

async function copyFileAtomic(sourcePath, targetPath, targetDir, fileName) {
  const tempPath = join(targetDir, `.${fileName}.${process.pid}.${Date.now()}.tmp`);
  try {
    await copyFile(sourcePath, tempPath);
    await rename(tempPath, targetPath);
  } catch (err) {
    await unlink(tempPath).catch((unlinkErr) => {
      if (unlinkErr?.code !== 'ENOENT') {
        console.warn('[reset-shipped-icons] Failed to remove temp file:', unlinkErr instanceof Error ? unlinkErr.message : String(unlinkErr));
      }
    });
    throw err;
  }
}

export async function resetShippedIcons(options = {}) {
  const matrixHome = validateRootPath('matrixHome', options.matrixHome ?? process.env.MATRIX_HOME ?? DEFAULT_MATRIX_HOME);
  const templateHome = validateRootPath('templateHome', options.templateHome ?? process.env.MATRIX_TEMPLATE_HOME ?? DEFAULT_TEMPLATE_HOME);
  const dryRun = Boolean(options.dryRun);
  const backupStamp = validateBackupStamp(options.backupStamp ?? utcStamp());
  const sourceDir = join(templateHome, 'system/icons');
  const targetDir = join(matrixHome, 'system/icons');
  const backupDir = join(matrixHome, 'system/icon-backups', backupStamp);
  const result = {
    sourceDir,
    targetDir,
    backupDir,
    dryRun,
    copied: [],
    backedUp: [],
    unchanged: [],
    skipped: [],
  };

  const sourceEntries = (await readdir(sourceDir))
    .filter((fileName) => ICON_EXTENSIONS.has(fileName.slice(fileName.lastIndexOf('.'))))
    .sort();

  if (!dryRun) {
    await mkdir(targetDir, { recursive: true });
  }

  for (const fileName of sourceEntries) {
    if (!isIconFileName(fileName) || basename(fileName) !== fileName) {
      result.skipped.push({ file: fileName, reason: 'invalid-name' });
      continue;
    }

    const sourcePath = join(sourceDir, fileName);
    const targetPath = join(targetDir, fileName);
    const sourceStat = await lstat(sourcePath);
    if (sourceStat.isSymbolicLink()) {
      result.skipped.push({ file: fileName, reason: 'source-symlink' });
      continue;
    }
    if (!sourceStat.isFile()) {
      result.skipped.push({ file: fileName, reason: 'source-not-file' });
      continue;
    }
    if (sourceStat.size > MAX_ICON_BYTES) {
      result.skipped.push({ file: fileName, reason: 'source-too-large' });
      continue;
    }

    const targetStat = await lstatOrNull(targetPath);
    if (targetStat?.isSymbolicLink()) {
      result.skipped.push({ file: fileName, reason: 'target-symlink' });
      continue;
    }
    if (targetStat && !targetStat.isFile()) {
      result.skipped.push({ file: fileName, reason: 'target-not-file' });
      continue;
    }
    if (targetStat && await sameFileBytes(sourcePath, targetPath)) {
      result.unchanged.push(fileName);
      continue;
    }

    result.copied.push(fileName);
    if (targetStat) {
      result.backedUp.push(fileName);
      if (!dryRun) {
        await mkdir(backupDir, { recursive: true });
        await copyFile(targetPath, join(backupDir, fileName));
      }
    }
    if (!dryRun) {
      await copyFileAtomic(sourcePath, targetPath, targetDir, fileName);
    }
  }

  return result;
}

function parseArgs(argv) {
  const options = {};
  const readValue = (name, index) => {
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for ${name}`);
    }
    return value;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      options.dryRun = true;
      continue;
    }
    if (arg === '--home') {
      options.matrixHome = readValue(arg, i);
      i += 1;
      continue;
    }
    if (arg === '--template') {
      options.templateHome = readValue(arg, i);
      i += 1;
      continue;
    }
    if (arg === '--backup-stamp') {
      options.backupStamp = readValue(arg, i);
      i += 1;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function usage() {
  return [
    'Usage: node scripts/reset-shipped-icons.mjs [--home /home/matrix/home] [--template /opt/matrix/app/home] [--dry-run]',
    '',
    'Copies shipped PNG/SVG icons from the bundle template into a Matrix home.',
    'Changed existing icon files are backed up under system/icon-backups/<stamp>.',
  ].join('\n');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  const result = await resetShippedIcons(options);
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((err) => {
    console.error('[reset-shipped-icons] failed:', err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}
