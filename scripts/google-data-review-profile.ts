#!/usr/bin/env bun
import { fileURLToPath } from 'node:url';
import { isAbsolute, resolve } from 'node:path';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { z } from 'zod/v4';
import { createGoogleDataRepository } from '../packages/gateway/src/google-data/repository.js';
import { createGoogleOperatorEvidenceFiles } from '../packages/gateway/src/google-data/operator-evidence-files.js';
import { GoogleProcessingReviewError, GoogleReviewFilenameSchema, reviewGoogleProcessingProfile } from '../packages/gateway/src/google-data/operator-review.js';

const optionsSchema = z.strictObject({
  evidenceDir: z.string().min(1).max(4096).refine(value => isAbsolute(value) && resolve(value) === value),
  profile: GoogleReviewFilenameSchema, manifest: GoogleReviewFilenameSchema,
  expectedManifestDigest: z.string().regex(/^[a-f0-9]{64}$/),
  expectedRevision: z.number().int().min(0).max(2_147_483_645), apply: z.boolean(),
  databaseHost: z.string().regex(/^[a-z0-9][a-z0-9.-]{0,252}$/).optional(),
  databaseName: z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,62}$/).optional(),
  receipt: GoogleReviewFilenameSchema.optional(),
}).refine(value => !value.apply || Boolean(value.databaseHost && value.databaseName && value.receipt))
  .refine(value => value.profile !== value.manifest && value.receipt !== value.profile && value.receipt !== value.manifest);
export type GoogleReviewCliOptions = z.infer<typeof optionsSchema>;
function deny(): never { throw new GoogleProcessingReviewError(); }

export function parseGoogleDataReviewArgs(args: string[]): GoogleReviewCliOptions {
  try {
    const names: Record<string, string> = { '--evidence-dir': 'evidenceDir', '--profile': 'profile', '--manifest': 'manifest',
      '--expected-manifest-sha256': 'expectedManifestDigest', '--expected-revision': 'expectedRevision',
      '--database-host': 'databaseHost', '--database-name': 'databaseName', '--receipt': 'receipt' };
    const values: Record<string, unknown> = { apply: false };
    const seen = new Set<string>();
    if (args.length > 19) deny();
    for (let index = 0; index < args.length; index += 1) {
      const flag = args[index]!;
      if (seen.has(flag)) deny();
      seen.add(flag);
      if (flag === '--apply') { values.apply = true; continue; }
      const key = Object.hasOwn(names, flag) ? names[flag] : undefined;
      const value = args[++index];
      if (!key || !value || value.startsWith('--')) deny();
      if (key === 'expectedRevision') {
        if (!/^(0|[1-9][0-9]{0,9})$/.test(value)) deny();
        values[key] = Number(value);
      } else values[key] = value;
    }
    return optionsSchema.parse(values);
  } catch (error: unknown) {
    if (error instanceof GoogleProcessingReviewError) throw error;
    throw new GoogleProcessingReviewError();
  }
}

/** Do not use DATABASE_URL, dotenv files, Pg environment defaults, or URL routing overrides for this operator mutation. */
export function pinnedGoogleReviewDatabase(options: GoogleReviewCliOptions, environment: Record<string, string | undefined>): string {
  try {
    const value = environment.MATRIX_GOOGLE_REVIEW_DATABASE_URL;
    if (!options.apply || !value || value.length > 8192 || value !== value.trim() || /[\u0000-\u0020\u007f]/.test(value)) deny();
    const url = new URL(value);
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.username || !url.password || url.hash
      || url.hostname !== options.databaseHost || (url.port !== '' && url.port !== '5432')
      || decodeURIComponent(url.pathname) !== `/${options.databaseName}`
      || [...url.searchParams.keys()].some(key => key !== 'sslmode')
      || url.searchParams.getAll('sslmode').length !== 1
      || !['require', 'verify-full', 'verify-ca'].includes(url.searchParams.get('sslmode') ?? '')) deny();
    return value;
  } catch (error: unknown) {
    if (error instanceof GoogleProcessingReviewError) throw error;
    throw new GoogleProcessingReviewError();
  }
}

/** Manual operator command. It never installs schema, records owner consent, or enables inference. */
export async function runGoogleDataReviewCli(args: string[], environment: Record<string, string | undefined> = process.env) {
  const options = parseGoogleDataReviewArgs(args);
  // Validate apply routing before any file reservation or database creation.
  const databaseUrl = options.apply ? pinnedGoogleReviewDatabase(options, environment) : null;
  const files = await createGoogleOperatorEvidenceFiles(options.evidenceDir);
  let db: Kysely<Record<string, never>> | undefined;
  let pool: pg.Pool | undefined;
  let repository: ReturnType<typeof createGoogleDataRepository> | undefined;
  let receipt: Awaited<ReturnType<typeof files.reserveReceipt>> | undefined;
  try {
    const profileBytes = await files.readArtifact(options.profile);
    const manifestBytes = await files.readArtifact(options.manifest);
    let profile: unknown;
    try { profile = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(profileBytes)); }
    catch (error: unknown) { if (error instanceof Error) deny(); throw new GoogleProcessingReviewError(); }
    const request = { profile, manifestBytes, expectedManifestDigest: options.expectedManifestDigest, expectedRevision: options.expectedRevision };
    const dryRun = await reviewGoogleProcessingProfile(request, {
      readArtifact: files.readArtifact,
      repository: { reviewProfile: async () => deny() },
    });
    if (!options.apply) {
      if (options.receipt) await files.writeReceipt(options.receipt, dryRun);
      return dryRun;
    }
    // Reserve the receipt before mutation. A pending receipt after interruption requires inspection,
    // never an automatic retry or an assumption that the transaction failed.
    receipt = await files.reserveReceipt(options.receipt!);
    await receipt.write({ ...dryRun, mode: 'pending', recordedAt: new Date().toISOString() });
    const pinnedDatabaseUrl = new URL(databaseUrl!);
    // pg reparses connectionString after config: an empty parsed port would otherwise
    // overwrite port:5432 and let its connection parameters consult ambient PGPORT.
    pinnedDatabaseUrl.port = '5432';
    pool = new pg.Pool({ connectionString: pinnedDatabaseUrl.href, max: 1, connectionTimeoutMillis: 10_000,
      idleTimeoutMillis: 5_000, statement_timeout: 5_000, query_timeout: 10_000, port: 5432,
      options: '-c search_path=public',
      application_name: 'matrix-google-profile-operator' });
    db = new Kysely<Record<string, never>>({ dialect: new PostgresDialect({ pool }) });
    repository = createGoogleDataRepository(db);
    const result = await reviewGoogleProcessingProfile({ ...request, apply: true }, { repository, readArtifact: files.readArtifact });
    await receipt.write({ ...result, recordedAt: new Date().toISOString() });
    return result;
  } catch (error: unknown) {
    // An existing pending receipt is preserved: a database response could have been lost.
    if (error instanceof GoogleProcessingReviewError) throw error;
    throw new GoogleProcessingReviewError();
  } finally {
    let cleanupFailed = false;
    for (const close of [() => repository?.close(), () => db ? db.destroy() : pool?.end(), () => receipt?.close(), () => files.close()]) {
      try { await close(); }
      catch (error: unknown) {
        cleanupFailed = true;
        console.warn('[google-data] Operator resource cleanup failed:', error instanceof Error ? 'operation_failed' : 'untyped_failure');
      }
    }
    if (cleanupFailed) throw new GoogleProcessingReviewError();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runGoogleDataReviewCli(process.argv.slice(2)).then(result => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }).catch((error: unknown) => {
    process.stderr.write(`${error instanceof GoogleProcessingReviewError ? error.message : 'Google processing review unavailable'}\n`);
    process.exitCode = 1;
  });
}
