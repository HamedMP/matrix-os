#!/usr/bin/env bun
/** Reviewed operator exception; no migrations, sweep, host calls or automatic retries. */
import { constants } from 'node:fs';
import { lstat, open, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { z } from 'zod/v4';
import type { PlatformDatabase } from '../../packages/platform/src/db.js';
import { wrapPlatformDb } from '../../packages/platform/src/database/transaction-scope.js';
import { createPaidStarterRecovery, PaidStarterRecoveryReviewSchema,
  type PaidStarterRecoveryResult } from '../../packages/platform/src/customer-funded-paid-recovery.js';
import { parseUniqueOperatorJson, readProtectedOperatorInput } from './runtime-token-protected-input.js';

const Fingerprint = z.string().regex(/^[a-f0-9]{64}$/);
const AppliedResult = z.object({ mode: z.literal('applied'), fingerprint: Fingerprint,
  targetCount: z.number().int().min(1).max(3), grantedMicrousd: z.number().int() }).strict()
  .refine(result => result.grantedMicrousd === result.targetCount * 5_000_000);

export function parsePaidStarterRecoveryArguments(args: string[]) {
  const [file, ...rest] = args;
  if (!file || file.startsWith('--') || (rest.length !== 0 && (rest.length !== 5
    || rest[0] !== '--apply' || rest[1] !== '--reviewed-sha256' || !Fingerprint.safeParse(rest[2]).success
    || rest[3] !== '--journal' || !rest[4] || rest[4].startsWith('--')))) {
    throw new Error('Usage: bun scripts/ops/recover-paid-starter-credit.ts <private-review.json> [--apply --reviewed-sha256 <hash> --journal <new-private-result.json>]');
  }
  return rest.length === 0 ? { file, apply: false }
    : { file, apply: true, reviewedFingerprint: rest[2], journal: rest[4] };
}
export async function readPaidStarterRecoveryReview(path: string) {
  return PaidStarterRecoveryReviewSchema.parse(parseUniqueOperatorJson(await readProtectedOperatorInput(path)));
}
async function syncDirectory(path: string) {
  const directory = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await directory.sync(); } finally { await directory.close(); }
}

/** A pending file deliberately survives every failure/unknown commit. Never reuse it. */
export async function claimPaidStarterRecoveryJournal(path: string, inputFingerprint: string) {
  const fingerprint = Fingerprint.parse(inputFingerprint); const target = resolve(path);
  const parent = dirname(target);
  const journal = await open(target, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  let original: Awaited<ReturnType<typeof lstat>>;
  try {
    await journal.writeFile(JSON.stringify({ status: 'pending', fingerprint }) + '\n');
    await journal.sync(); original = await journal.stat();
  } finally { await journal.close(); }
  // Reuse the reviewed reader's ancestor pinning, owner, hardlink and mode checks.
  await readProtectedOperatorInput(target); await syncDirectory(parent);
  let completed = false;
  return {
    async complete(input: PaidStarterRecoveryResult) {
      const result = AppliedResult.parse(input);
      if (completed || result.fingerprint !== fingerprint) throw new Error('Recovery journal mismatch');
      const pending = parseUniqueOperatorJson(await readProtectedOperatorInput(target));
      const metadata = await lstat(target);
      if (JSON.stringify(pending) !== JSON.stringify({ status: 'pending', fingerprint })
        || metadata.dev !== original.dev || metadata.ino !== original.ino) throw new Error('Recovery journal changed');
      const temporary = resolve(parent, `.${basename(target)}.${randomUUID()}.incoming`);
      const next = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      try {
        try { await next.writeFile(JSON.stringify({ status: 'applied', ...result }) + '\n'); await next.sync(); }
        finally { await next.close(); }
        const current = await lstat(target);
        if (current.dev !== original.dev || current.ino !== original.ino || current.nlink !== 1) throw new Error('Recovery journal changed');
        // Atomic replacement only after the database acknowledged commit. A
        // crash before here leaves pending; readers must reconcile, not replay.
        await rename(temporary, target); await syncDirectory(parent); completed = true;
      } finally {
        try { await unlink(temporary); }
        catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
      }
    },
  };
}

async function checkedSourceSha(): Promise<string> {
  const repository = fileURLToPath(new URL('../..', import.meta.url));
  const git = promisify(execFile);
  const options = { cwd: repository, timeout: 5000, maxBuffer: 64 * 1024 };
  const head = (await git('git', ['rev-parse', 'HEAD'], options)).stdout.trim();
  // Running a reviewed hash while tracked/untracked source differs is not that
  // reviewed implementation. Private reviews/journals belong outside checkout.
  const changes = (await git('git', ['status', '--porcelain', '--untracked-files=normal'], options)).stdout;
  if (!/^[a-f0-9]{40}$/.test(head) || changes.trim()) throw new Error('Reviewed clean source is required');
  return head;
}

/** No startup constructor: creating/awaiting this handle cannot run migrations. */
export function openPaidStarterRecoveryDatabase(connectionString: string, apply: boolean,
  createPool: (config: pg.PoolConfig) => pg.Pool = config => new pg.Pool(config)) {
  const url = new URL(connectionString);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)
    || (!['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) && url.searchParams.get('sslmode') !== 'verify-full')) {
    throw new Error('Verified database transport is required');
  }
  const pool = createPool({ connectionString, max: 1, connectionTimeoutMillis: 10_000,
    statement_timeout: 15_000, lock_timeout: 3000,
    options: apply ? undefined : '-c default_transaction_read_only=on' });
  pool.on('error', () => { console.error('Operator database connection failed'); });
  let driverOwnsPool = false;
  const root = new Kysely<PlatformDatabase>({ dialect: new PostgresDialect({ pool: async () => {
    driverOwnsPool = true; return pool;
  } }) });
  return wrapPlatformDb(root, root, Promise.resolve(), async () => {
    await root.destroy();
    // Kysely has not acquired its dialect pool if validation failed before the
    // first query. Close that already-created owning pool in that case too.
    if (!driverOwnsPool) await pool.end();
  });
}

async function main() {
  const args = parsePaidStarterRecoveryArguments(process.argv.slice(2));
  const review = await readPaidStarterRecoveryReview(args.file);
  const sourceSha = await checkedSourceSha();
  if (review.sourceSha !== sourceSha) throw new Error('Reviewed source changed');
  const connectionString = process.env.PLATFORM_DATABASE_URL;
  if (!connectionString) throw new Error('Operator database configuration is required');
  const journal = args.apply && args.journal && args.reviewedFingerprint
    ? await claimPaidStarterRecoveryJournal(args.journal, args.reviewedFingerprint) : undefined;
  // Deliberately bypass createPlatformDb: reviewed schema deployment owns migrations.
  const db = openPaidStarterRecoveryDatabase(connectionString, args.apply);
  try {
    const schema = await sql<{ generation: number }>`SELECT generation FROM platform_schema_revisions WHERE scope='core'`.execute(db.executor);
    if ((schema.rows[0]?.generation ?? 0) < 18) throw new Error('Reviewed schema is required');
    const result = await createPaidStarterRecovery({ db, env: process.env, sourceSha, now: () => new Date() })
      (review, { apply: args.apply, ...('reviewedFingerprint' in args ? { reviewedFingerprint: args.reviewedFingerprint } : {}) });
    await journal?.complete(result);
    process.stdout.write(JSON.stringify(result) + '\n');
  } finally { await db.destroy(); }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(() => {
    console.error('Paid starter recovery failed; reconcile the private journal and current database before retrying');
    process.exitCode = 1;
  });
}
