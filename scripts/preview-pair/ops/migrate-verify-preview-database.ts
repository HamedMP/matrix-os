import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const candidateRoot = process.env.MATRIX_PREVIEW_CANDIDATE_ROOT;
const candidateSha = process.env.MATRIX_PREVIEW_CANDIDATE_SHA;
if (!candidateRoot || !candidateSha || !/^[a-f0-9]{40}$/.test(candidateSha) || !process.argv.includes('--apply')) {
  throw new Error('Set exact MATRIX_PREVIEW_CANDIDATE_ROOT/SHA and pass --apply after review');
}
const root = resolve(candidateRoot);
const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', timeout: 10_000 }).trim();
if (git('rev-parse','HEAD') !== candidateSha || git('status','--porcelain')) throw new Error('Use a clean exact candidate checkout');
const moduleUrl = (path: string) => pathToFileURL(resolve(root, path)).href;
const { createPreviewPairTargetDatabase, assertPreviewPairTargetPrepared } = await import(moduleUrl('packages/platform/src/preview-pair/target-database.ts'));
const { assertPreviewPairDataIsolation } = await import(moduleUrl('packages/platform/src/preview-pair/projection.ts'));
const { runPlatformStartupMigrations } = await import(moduleUrl('packages/platform/src/database/run-migrations.ts'));
const { bootstrapPlatformCollaborationDatabase } = await import(moduleUrl('packages/platform/src/collaboration/database.ts'));
const { sql } = createRequire(resolve(root,'package.json'))('kysely');
const project = 'matrix-os-1144';
const load = (name: string, version = '1') => execFileSync('gcloud', ['secrets', 'versions', 'access', version,
  `--secret=${name}`, `--project=${project}`], { encoding: 'utf8', timeout: 15_000 }).trim();
function normalized(raw: string) {
  const u = new URL(raw);
  if (!['postgres:', 'postgresql:'].includes(u.protocol)) throw new Error('Unexpected database URL');
  if (['prefer', 'require', 'verify-ca'].includes(u.searchParams.get('sslmode') ?? '')) u.searchParams.set('sslmode', 'verify-full');
  return u;
}
const control = normalized(load('platform-database-url', 'latest'));
const preview = normalized(load('matrix-pair-preview-database-url'));
if (preview.username !== 'matrix_pair_preview' || preview.pathname !== '/matrix_pair_preview'
  || control.username === preview.username || control.pathname === preview.pathname
  || control.hostname !== preview.hostname || control.port !== preview.port) throw new Error('Unexpected preview database binding');
const receiptPath = new URL('./database-migration-receipt.json', import.meta.url);
// Reserve a fresh private receipt before connecting; never depend on a prior operator's files.
await writeFile(receiptPath, '{}\n', { flag: 'wx', mode: 0o600 });
const receipt: Record<string, any> = { candidateSha, state: 'preflight', sourceCatalogOnly: true };
// These constructors do not migrate either database. Source is used only for
// the production isolation gate's catalog checks; all DDL uses the preview login.
const source = createPreviewPairTargetDatabase(control.href);
const target = createPreviewPairTargetDatabase(preview.href);
try {
  const before = await sql`SELECT current_database() AS database, session_user AS role`.execute(target.executor);
  if (before.rows[0]?.database !== 'matrix_pair_preview' || before.rows[0]?.role !== 'matrix_pair_preview') throw new Error('Wrong migration target');
  await assertPreviewPairDataIsolation(source, target);
  await runPlatformStartupMigrations(target.executor);
  await bootstrapPlatformCollaborationDatabase(target.executor as never);
  await assertPreviewPairTargetPrepared(source, target);
  const schema = await sql`SELECT
    to_regclass('user_machines') IS NOT NULL AS machines,
    to_regclass('host_bundle_releases') IS NOT NULL AS releases,
    to_regclass('collaboration_directory') IS NOT NULL AS directory,
    to_regclass('collaboration_app_presentations') IS NOT NULL AS artwork`.execute(target.executor);
  if (!Object.values(schema.rows[0] ?? {}).every(value => value === true) || Object.keys(schema.rows[0] ?? {}).length !== 4) throw new Error('Required candidate schema is missing');
  const empty = await sql`SELECT (SELECT count(*)::integer FROM user_machines) AS machines,
    (SELECT count(*)::integer FROM collaboration_directory) AS shares`.execute(target.executor);
  if (empty.rows[0]?.machines !== 0 || empty.rows[0]?.shares !== 0) throw new Error('Unexpected data in fresh preview database');
  await target.transaction(async (trx: any) => {
    await sql`CREATE TABLE eng418_bootstrap_write_probe (id integer PRIMARY KEY, value text NOT NULL)`.execute(trx.executor);
    await sql`INSERT INTO eng418_bootstrap_write_probe (id,value) VALUES (1,'preview-only')`.execute(trx.executor);
    const observed = await sql`SELECT value FROM eng418_bootstrap_write_probe WHERE id=1`.execute(trx.executor);
    if (observed.rows[0]?.value !== 'preview-only') throw new Error('Preview write/read probe failed');
    await sql`DROP TABLE eng418_bootstrap_write_probe`.execute(trx.executor);
  });
  receipt.state = 'verified';
  receipt.candidateSha = candidateSha;
  receipt.migrations = { core: true, collaboration: true, artwork: true, executedAsRestrictedLogin: true };
  receipt.isolation = { actualProductionGatePassed: true, sourceCatalogOnly: true,
    distinctDatabaseAndRole: true, noPrivilegedReachableRoles: true, noSourceTablePrivileges: true };
  receipt.previewWriteReadProbe = true; receipt.emptyRuntimeInventory = true;
  delete receipt.errorType; delete receipt.errorCode;
  await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(receipt));
} catch (error) {
  receipt.state = 'migration-failed'; receipt.errorType = error instanceof Error ? error.name : 'UnknownError';
  receipt.errorCode = typeof (error as any)?.code === 'string' && /^[A-Z0-9_]{1,40}$/.test((error as any).code) ? (error as any).code : null;
  await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
  console.error(JSON.stringify({ state: receipt.state, errorType: receipt.errorType, errorCode: receipt.errorCode }));
  process.exitCode = 1;
} finally { await target.destroy(); await source.destroy(); }
