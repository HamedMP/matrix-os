#!/usr/bin/env bun
/** Operator-only. Inventory/dry-run are read-only; apply commits exact reviewed provider deletion intents. */
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod/v4';
import { sql } from 'kysely';
import { openPaidStarterRecoveryDatabase } from './recover-paid-starter-credit.js';
import { parseUniqueOperatorJson, readProtectedOperatorInput } from './runtime-token-protected-input.js';
import { listExpiredTrialMachines, prepareExpiredTrialCleanup, ExpiredTrialCleanupReviewSchema } from '../../packages/platform/src/trial-retention.js';
import { createTrialRetentionProviderVerifier } from '../../packages/platform/src/trial-retention-provider.js';
import { createHetznerClient } from '../../packages/platform/src/customer-vps-hetzner.js';
import { loadCustomerVpsConfig } from '../../packages/platform/src/customer-vps-config.js';
import type { ExpiredTrialCleanupResult } from '../../packages/platform/src/trial-retention.js';

const Fingerprint = z.string().regex(/^[a-f0-9]{64}$/);
type Arguments = { mode: 'inventory' } | { mode: 'dry-run'; file: string }
  | { mode: 'apply'; file: string; reviewedFingerprint: string; journal: string };
export function parseTrialCleanupArguments(args: string[]): Arguments {
  if (args.length === 1 && args[0] === '--inventory') return { mode: 'inventory' };
  const [file, ...rest] = args;
  if (file && !file.startsWith('--')) {
    if (rest.length === 0) return { mode: 'dry-run', file };
    if (rest.length === 5 && rest[0] === '--apply' && rest[1] === '--reviewed-sha256'
      && Fingerprint.safeParse(rest[2]).success && rest[3] === '--journal' && rest[4] && !rest[4].startsWith('--')) {
      return { mode: 'apply', file, reviewedFingerprint: rest[2]!, journal: rest[4] };
    }
  }
  throw new Error('Usage: bun scripts/ops/cleanup-expired-trials.ts --inventory | <private-review.json> [--apply --reviewed-sha256 <hash> --journal <new-private-journal.jsonl>]');
}

async function requireCleanSource(): Promise<string> {
  const git = promisify(execFile);
  const options = { cwd: fileURLToPath(new URL('../..', import.meta.url)), timeout: 5000, maxBuffer: 64 * 1024 };
  const sha = (await git('git', ['rev-parse', 'HEAD'], options)).stdout.trim();
  const changes = (await git('git', ['status', '--porcelain', '--untracked-files=normal'], options)).stdout.trim();
  if (!/^[a-f0-9]{40}$/.test(sha) || changes) throw new Error('Reviewed clean source is required');
  return sha;
}

/** Append-only private receipt. Pending/unknown commits must be reconciled, never blindly replayed. */
export async function claimTrialCleanupJournal(path: string, fingerprintInput: string, sourceSha: string) {
  const fingerprint = Fingerprint.parse(fingerprintInput);
  if (!/^[a-f0-9]{40}$/.test(sourceSha)) throw new Error('Cleanup journal source mismatch');
  const target = resolve(path);
  const file = await open(target, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try {
    await file.writeFile(JSON.stringify({ status: 'pending', fingerprint, sourceSha }) + '\n'); await file.sync();
    await readProtectedOperatorInput(target);
    const original = await file.stat();
    const parent = await open(dirname(target), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await parent.sync(); } finally { await parent.close(); }
    let completed = false;
    return { async complete(result: ExpiredTrialCleanupResult) {
      if (completed || result.mode !== 'queued' || result.fingerprint !== fingerprint
        || !Number.isInteger(result.targetCount) || result.targetCount < 1 || result.targetCount > 5) throw new Error('Cleanup journal result mismatch');
      await readProtectedOperatorInput(target);
      const current = await lstat(target);
      if (current.dev !== original.dev || current.ino !== original.ino || current.nlink !== 1
        || current.size !== original.size || current.mtimeMs !== original.mtimeMs) throw new Error('Cleanup journal changed');
      await file.writeFile(JSON.stringify({ status: 'queued', result }) + '\n'); await file.sync();
      completed = true;
    }, close: () => file.close() };
  } catch (error) { await file.close(); throw error; }
}

async function main() {
  const args = parseTrialCleanupArguments(process.argv.slice(2));
  const connectionString = process.env.PLATFORM_DATABASE_URL;
  if (!connectionString) throw new Error('Operator database configuration is required');
  // This existing operator handle never invokes migrations and defaults to read-only connections.
  const db = openPaidStarterRecoveryDatabase(connectionString, args.mode === 'apply');
  let journal: Awaited<ReturnType<typeof claimTrialCleanupJournal>> | undefined;
  try {
    if (args.mode === 'inventory') {
      const inventory = await db.transaction(async trx => {
        await sql`SET TRANSACTION READ ONLY`.execute(trx.executor);
        await sql`SET LOCAL statement_timeout = '5000ms'`.execute(trx.executor);
        return listExpiredTrialMachines(trx, new Date());
      });
      process.stdout.write(JSON.stringify({ mode: 'inventory', reviewOnly: true, candidates: inventory }) + '\n');
      return;
    }
    const sourceSha = await requireCleanSource();
    const review = ExpiredTrialCleanupReviewSchema.parse(parseUniqueOperatorJson(await readProtectedOperatorInput(args.file)));
    if (review.sourceSha !== sourceSha) throw new Error('Reviewed source changed');
    const stripeSecretKey = process.env.STRIPE_SECRET_KEY; const hetznerToken = process.env.HETZNER_API_TOKEN;
    if (!stripeSecretKey || !hetznerToken) throw new Error('Read-only provider verification configuration is required');
    const hetzner = createHetznerClient(loadCustomerVpsConfig(process.env));
    const verifyProvider = createTrialRetentionProviderVerifier({ stripeSecretKey, getServer: id => hetzner.getServer(id) });
    if (args.mode === 'apply') journal = await claimTrialCleanupJournal(args.journal, args.reviewedFingerprint, sourceSha);
    const result = await prepareExpiredTrialCleanup({ db, verifyProvider, sourceSha }, review, args.mode === 'apply'
      ? { apply: true, reviewedFingerprint: args.reviewedFingerprint } : {});
    await journal?.complete(result); process.stdout.write(JSON.stringify({ ...result, sourceSha }) + '\n');
  } finally { try { await journal?.close(); } finally { await db.destroy(); } }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(() => {
    console.error('Expired trial cleanup failed; reconcile the private journal and current eligibility before retrying');
    process.exitCode = 1;
  });
}
