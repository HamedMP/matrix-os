// Trusted operator checkout only. This program accepts private filenames, never secrets in argv.
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod/v4';
import { sql } from 'kysely';
import { OperatorProbeBudgetConfigSchema, OperatorProbeBudgetStatusSchema, OperatorProbeHashSchema,
  operatorProbeRpc, type OperatorProbeBudgetStatus } from '@matrix-os/contracts/funded-operator-probe';
import { operatorProbePolicy } from '../packages/proxy/src/operator-probe-price.js';
import { readFundedPricingReviews } from '../packages/proxy/src/funded-pricing-review.js';
import { createOperatorProbeBudgetDatabase } from '../packages/platform/src/operator-probe-budget/database.js';
import { startOperatorProbeAuthority } from '../packages/platform/src/operator-probe-budget/main.js';
import { createOperatorProbeBudgetRepository, initializeOperatorProbeBudget } from '../packages/platform/src/operator-probe-budget/repository.js';
import { OPERATOR_PROBE_AUTHORITY_BASE } from '../packages/platform/src/operator-probe-budget/routes.js';

const id = z.string().trim().min(1).max(160);
const token = z.string().min(32).max(4096);
const pgName = z.string().regex(/^[a-z_][a-z0-9_-]{0,62}$/);
const Authority = z.strictObject({
  databaseUrl: z.string().max(4096), expectedDatabase: pgName, expectedRole: pgName,
  expectedSchema: pgName.refine(v => !v.startsWith('pg_') && v !== 'information_schema'),
  budgetId: id, token, hostname: z.enum(['127.0.0.1', '::1']), port: z.number().int().min(1024).max(65535),
}).refine(c => {
  const u = URL.canParse(c.databaseUrl) && new URL(c.databaseUrl);
  if (!u || !['postgresql:', 'postgres:'].includes(u.protocol) || !['127.0.0.1', '[::1]'].includes(u.hostname)
    || u.hash || !u.username || !u.pathname.slice(1) || decodeURIComponent(u.pathname.slice(1)) !== c.expectedDatabase
    || decodeURIComponent(u.username) !== c.expectedRole) return false;
  // pg connection string parameters can override fields, including host and user.
  return [...u.searchParams].every(([k, v]) => k === 'options' && v === '-c search_path=' + c.expectedSchema);
});
const Plan = z.strictObject({ budgetId: id, source: id, revision: id, expiresAt: z.iso.datetime(),
  allocationMicrousd: z.literal(6_250_000), historicalReserveMicrousd: z.literal(1_000_000), historicalUnpriced: z.literal(true),
  models: z.array(id).min(1).max(100), pricingEnv: z.record(z.string().regex(/^MATRIX_FUNDED_[A-Z0-9_]+_PRICING_(?:REVIEW_VERSION|REVIEWED_AT|VALID_THROUGH)$/),
    z.string().min(1).max(160)) });
const Doctor = z.strictObject({ authorityUrl: z.string().max(2048), expectedBinding: OperatorProbeHashSchema, token, budgetId: id });
const denied = () => new Error('Operator probe configuration or target verification failed');
const root = fileURLToPath(new URL('../', import.meta.url));

export async function readPrivateJson(path: string): Promise<unknown> {
  if (!isAbsolute(path) || path !== await realpath(path) || !relative(root, path).startsWith('../')) throw denied();
  const parent = await stat(dirname(path));
  const uid = process.getuid?.();
  if (uid === undefined || !parent.isDirectory() || parent.uid !== uid || (parent.mode & 0o777) !== 0o700) throw denied();
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const s = await file.stat();
    if (!s.isFile() || s.nlink !== 1 || s.uid !== uid || (s.mode & 0o777) !== 0o600 || s.size > 32_768) throw denied();
    // A bounded read also limits a concurrent append after fstat.
    const b = Buffer.alloc(32_769);
    let used = 0;
    while (used < b.length) {
      const { bytesRead } = await file.read(b, used, b.length - used);
      if (!bytesRead) break;
      used += bytesRead;
    }
    if (used > 32_768) throw denied();
    return JSON.parse(b.toString('utf8', 0, used));
  } finally { await file.close(); }
}

export function planWallet(raw: unknown, budgetId: string, now: Date) {
  const { models, pricingEnv, ...plan } = Plan.parse(raw);
  const expires = Date.parse(plan.expiresAt);
  if (plan.budgetId !== budgetId || expires <= +now) throw denied();
  const reviews = readFundedPricingReviews(pricingEnv);
  const policies = [...models].sort().map(model => operatorProbePolicy(model, now, reviews));
  if (policies.some(p => expires > Date.parse(p.pricingValidThrough))) throw denied();
  return OperatorProbeBudgetConfigSchema.parse({ ...plan, enabled: true, policies });
}

function summary(wallet: OperatorProbeBudgetStatus | null) {
  if (!wallet) return { initialized: false } as const;
  return { initialized: true, walletBinding: wallet.walletBinding, enabled: wallet.enabled,
    frozen: wallet.frozen, expiresAt: wallet.expiresAt, allocationMicrousd: wallet.allocationMicrousd,
    historicalReserveMicrousd: wallet.historicalReserveMicrousd, historicalUnpriced: wallet.historicalUnpriced,
    historicalCostMicrousd: null, prospectiveSettledMicrousd: wallet.settledMicrousd, heldMicrousd: wallet.heldMicrousd,
    availableMicrousd: wallet.availableMicrousd, attemptCount: wallet.attemptCount };
}

export async function doctor(raw: unknown, fetcher = fetch) {
  const c = Doctor.parse(raw);
  const rpc = operatorProbeRpc(c.authorityUrl, OPERATOR_PROBE_AUTHORITY_BASE, c.token, fetcher,
    { 'if-match': '"' + createHash('sha256').update(c.budgetId).digest('hex') + '"' });
  const result = await rpc('status', undefined, OperatorProbeBudgetStatusSchema.nullable(), 2000);
  if (!result || result.budgetId !== c.budgetId || result.walletBinding !== c.expectedBinding) throw denied();
  return summary(result);
}

export async function runOperatorWallet(args: string[], now = new Date()) {
  const [action, path, plan] = args;
  if (!path || args.length !== (action === 'initialize' ? 3 : 2)
    || !['serve', 'initialize', 'inspect', 'doctor'].includes(action!)) throw denied();
  const raw = await readPrivateJson(path);
  if (action === 'doctor') return doctor(raw);
  const c = Authority.parse(raw);
  type DB = ReturnType<typeof createOperatorProbeBudgetDatabase>;
  async function verify(db: DB) {
    const { rows: [actual] } = await sql<{ db: string; role: string; schemas: string[] }>`SELECT current_database() AS db,
      current_user AS role, current_schemas(false)::text[] AS schemas`.execute(db);
    if (!actual || actual.db !== c.expectedDatabase || actual.role !== c.expectedRole
      || actual.schemas.length !== 1 || actual.schemas[0] !== c.expectedSchema) throw denied();
  }
  if (action === 'serve') {
    return startOperatorProbeAuthority({ MATRIX_FUNDED_AI_OPERATOR_PROBE_AUTHORITY_DATABASE_URL: c.databaseUrl,
      MATRIX_FUNDED_AI_OPERATOR_PROBE_AUTHORITY_TOKEN: c.token, MATRIX_FUNDED_AI_OPERATOR_PROBE_BUDGET_ID: c.budgetId,
      MATRIX_FUNDED_AI_OPERATOR_PROBE_AUTHORITY_HOST: c.hostname, MATRIX_FUNDED_AI_OPERATOR_PROBE_AUTHORITY_PORT: String(c.port) }, verify);
  }
  const init = action === 'initialize' ? planWallet(await readPrivateJson(plan!), c.budgetId, now) : undefined;
  const db = createOperatorProbeBudgetDatabase(c.databaseUrl);
  try {
    return await db.connection().execute(async cx => {
      await verify(cx);
      if (init) await initializeOperatorProbeBudget(cx, init, { dedicatedAuthority: true });
      return summary(await createOperatorProbeBudgetRepository({ db: cx, budgetId: c.budgetId }).getStatus());
    });
  } finally { await db.destroy(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const fail = () => { console.error('Operator probe command failed; verify private configuration and target.'); process.exitCode = 1; };
  runOperatorWallet(process.argv.slice(2)).then(result => {
    if ('server' in result) {
      const stop = () => { void result.close().catch(fail); };
      process.once('SIGINT', stop); process.once('SIGTERM', stop);
      console.log('Dedicated loopback authority listening.');
    } else console.log(JSON.stringify(result));
  }).catch(fail);
}
