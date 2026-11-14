import { constants } from 'node:fs';
import { lstat, mkdir, open, opendir, realpath, unlink } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { z } from 'zod/v4';
import { getConfigDir } from '../../lib/config.js';
import { cliError } from '../output.js';

const retention = 24 * 60 * 60_000;
export const sourceRunIdSchema = z.uuidv4().refine(value => value === value.toLowerCase());
const recordSchema = z.strictObject({ version: z.literal(1), runId: sourceRunIdSchema,
  key: z.string().length(64).regex(/^[a-f0-9]+$/), origin: z.string().url().max(256),
  sourceIdentity: z.string().length(64).regex(/^[a-f0-9]+$/),
  runtime: z.string().max(32).regex(/^[a-z0-9-]+$/), worktree: z.string().max(32).regex(/^[a-z0-9-]+$/),
  createdAt: z.number().int().positive() });
export type HostedSourceRun = z.infer<typeof recordSchema>;
const unavailable = () => cliError('devstack_run_state_unavailable', 'DevStack recovery state is unavailable for this worktree.');

async function directory() {
  const base = resolve(getConfigDir());
  await mkdir(base, { recursive: true, mode: 0o700 });
  const parent = await lstat(base);
  if (!parent.isDirectory() || parent.uid !== process.getuid?.() || (parent.mode & 0o022) || await realpath(base) !== base) throw unavailable();
  const path = join(base, 'devstack-source-runs');
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) || await realpath(path) !== path) throw unavailable();
  return path;
}

/** Command-driven TTL cleanup. Never traverse or read a symlinked record. */
async function sweep(path: string) {
  let count = 0, inspected = 0;
  for await (const entry of await opendir(path)) {
    if (++inspected > 512) throw unavailable();
    if (!entry.name.endsWith('.json') || !sourceRunIdSchema.safeParse(entry.name.slice(0, -5)).success) continue;
    const file = join(path, entry.name);
    let stat;
    try { stat = await lstat(file); }
    catch (error: unknown) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    if (stat.isFile() && stat.uid === process.getuid?.() && stat.nlink === 1 && Date.now() - stat.mtimeMs >= retention) await unlink(file);
    else count++;
  }
  return count;
}

export async function saveHostedSourceRun(input: Pick<HostedSourceRun, 'origin' | 'sourceIdentity' | 'runtime' | 'worktree'>) {
  const record = recordSchema.parse({ version: 1, ...input, runId: randomUUID(), key: randomBytes(32).toString('hex'), createdAt: Date.now() });
  try {
    const path = await directory();
    if (await sweep(path) >= 256) throw unavailable();
    const file = await open(join(path, record.runId + '.json'), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await file.writeFile(JSON.stringify(record)); await file.sync(); }
    finally { await file.close(); }
    return record;
  } catch (error: unknown) {
    console.error('[devstack] Could not save recovery metadata', error instanceof Error ? error.name : 'Unknown');
    throw unavailable();
  }
}

export async function loadHostedSourceRun(runId: string, origin: string, sourceIdentity: string) {
  if (!sourceRunIdSchema.safeParse(runId).success) throw unavailable();
  try {
    const path = await directory();
    await sweep(path);
    const file = await open(join(path, runId + '.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.nlink !== 1 || (stat.mode & 0o077) || stat.size > 2048) throw unavailable();
      const record = recordSchema.parse(JSON.parse(await file.readFile('utf8')));
      if (record.runId !== runId || record.origin !== origin || record.sourceIdentity !== sourceIdentity
        || record.createdAt > Date.now() + 5000 || Date.now() - record.createdAt >= retention) throw unavailable();
      return record;
    } finally { await file.close(); }
  } catch (error: unknown) {
    console.error('[devstack] Could not load recovery metadata', error instanceof Error ? error.name : 'Unknown');
    throw unavailable();
  }
}
