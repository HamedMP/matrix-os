import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod/v4';
import type { Transaction } from 'kysely';
import { FUNDED_AI_AUDIENCE, FUNDED_AI_SCOPE, GOOGLE_QUALIFIED_FUNDED_TOKEN_PREFIX,
  parseGoogleQualifiedFundedCredential, type GoogleQualifiedFundedRoute, type GoogleQualifiedFundedBinding,
  type GoogleQualifiedFundedLease, type FundedAiIdentity, type FundedAiRequestClass } from '@matrix-os/contracts';
import type { PlatformDB, PlatformDatabase } from './db.js';
import { buildPlatformRuntimeVerificationToken, timingSafeTokenEquals } from './platform-token.js';
import { insertAiFundedRouteBinding } from './ai-funded-route-binding.js';
import { QualifiedFundedError } from './ai-funded-qualified-errors.js';

export const QualifiedRuntimeAuthSchema = z.strictObject({ handle: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
  runtimeSlot: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,79}$/), authorization: z.string().max(512) });
export type QualifiedRuntimeAuth = z.infer<typeof QualifiedRuntimeAuthSchema>;
export type QualifiedMachine = FundedAiIdentity & { handle: string; epoch: number };
function deny(): never { throw new QualifiedFundedError(); }
const epoch = (value: unknown): number => typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 2147483647 ? value : deny();
export function parseQualifiedIssuanceEpoch(tokenId: string): number {
  const match = /^q1_([1-9][0-9]{0,9})_([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$(?![\s\S])/.exec(tokenId);
  return match && BigInt(match[1]!) <= 2147483647n ? epoch(Number(match[1])) : deny();
}
export async function authenticateQualifiedMachine(db: PlatformDB, authInput: QualifiedRuntimeAuth, secret: string, lock = false): Promise<QualifiedMachine> {
  const parsed = QualifiedRuntimeAuthSchema.safeParse(authInput); if (!parsed.success) throw new QualifiedFundedError(401);
  const auth = parsed.data;
  let query = db.executor.selectFrom('user_machines').selectAll().where('handle', '=', auth.handle).where('runtime_slot', '=', auth.runtimeSlot)
    .where('status', '=', 'running').where('activation_state', '=', 'authorized').where('deleted_at', 'is', null);
  if (lock) query = query.forUpdate(); const machine = await query.executeTakeFirst();
  if (!machine || machine.status !== 'running' || machine.activation_state !== 'authorized' || machine.deleted_at !== null) throw new QualifiedFundedError(401);
  const currentEpoch = epoch(machine.runtime_token_epoch);
  const expected = buildPlatformRuntimeVerificationToken({ handle: auth.handle, machineId: machine.machine_id, runtimeSlot: auth.runtimeSlot }, secret, currentEpoch);
  if (!timingSafeTokenEquals(auth.authorization.startsWith('Bearer ') ? auth.authorization.slice(7) : undefined, expected)) throw new QualifiedFundedError(401);
  return { ownerId: machine.clerk_user_id, machineId: machine.machine_id, runtimeSlot: machine.runtime_slot, handle: machine.handle, epoch: currentEpoch };
}
export function sameQualifiedMachine(left: QualifiedMachine, right: QualifiedMachine): boolean {
  return left.ownerId === right.ownerId && left.machineId === right.machineId && left.runtimeSlot === right.runtimeSlot && left.handle === right.handle && left.epoch === right.epoch;
}
export function qualifiedTokenHash(token: string, secret: string): string { return createHmac('sha256', secret).update(token).digest('hex'); }
function models(raw: string): string[] {
  try { return z.array(z.string().min(1).max(200)).max(64).parse(JSON.parse(raw)); }
  catch (error) { throw new QualifiedFundedError(); }
}
/** Machine lock must already precede runtime/global locks. Returned rows remain locked through caller commit. */
export async function qualifiedPolicy(db: PlatformDB, identity: FundedAiIdentity, model: string, at: Date) {
  const runtime = await db.executor.selectFrom('ai_funded_runtime_policies').selectAll().where('machine_id', '=', identity.machineId).forUpdate().executeTakeFirst();
  const global = await db.executor.selectFrom('ai_funded_global_policy').selectAll().where('policy_id', '=', 'default').forShare().executeTakeFirst();
  const restriction = await db.executor.selectFrom('ai_funded_credit_restrictions').selectAll().where('machine_id', '=', identity.machineId).forShare().executeTakeFirst();
  if (!runtime || !global || runtime.owner_id !== identity.ownerId || runtime.runtime_slot !== identity.runtimeSlot || !runtime.enabled || !global.enabled
    || (runtime.expires_at !== null && Date.parse(runtime.expires_at) <= at.getTime()) || restriction?.frozen || BigInt(restriction?.debt_microusd ?? 0) > 0n) deny();
  const runtimeModels = models(runtime.allowed_model_ids); const allowed = models(global.allowed_model_ids).filter(value => runtimeModels.includes(value));
  if (!allowed.includes(model)) deny();
  return { runtime, policy: { enabled: true, globalRevision: global.revision, runtimeRevision: runtime.revision,
    allowedModelIds: allowed, monthlyBudgetMicrousd: Number(runtime.monthly_budget_microusd), checkedAt: at.toISOString(),
    staleAfter: new Date(at.getTime() + 60000).toISOString() } };
}
export async function mintQualifiedToken(db: PlatformDB, input: { machine: QualifiedMachine; route: GoogleQualifiedFundedRoute; requestClass: FundedAiRequestClass;
  policy: Awaited<ReturnType<typeof qualifiedPolicy>>; now: () => Date; hashSecret: string; ttlMs: number; cooldownMs: number }) {
  const at = input.now(); const { machine, route, requestClass } = input;
  const expiry = Math.min(at.getTime() + input.ttlMs, Date.parse(route.evidenceExpiresAt), input.policy.runtime.expires_at === null ? Infinity : Date.parse(input.policy.runtime.expires_at));
  if (!Number.isFinite(expiry) || expiry <= at.getTime() || at.getTime() < Date.parse(route.descriptor.evidence.reviewedAt)) deny();
  const tokenId = `q1_${epoch(machine.epoch)}_${randomUUID()}`; const token = `${GOOGLE_QUALIFIED_FUNDED_TOKEN_PREFIX}${tokenId}.${randomBytes(32).toString('base64url')}`;
  const column = requestClass === 'interactive' ? 'next_issue_at' : 'next_background_issue_at';
  const leased = await db.executor.updateTable('ai_funded_runtime_policies').set({ [column]: new Date(at.getTime() + input.cooldownMs).toISOString() })
    .where('machine_id', '=', machine.machineId).where('owner_id', '=', machine.ownerId).where('runtime_slot', '=', machine.runtimeSlot)
    .where(column, '<=', at.toISOString()).returning('machine_id').executeTakeFirst();
  if (!leased) deny();
  const credential = { token, tokenId, audience: FUNDED_AI_AUDIENCE, scope: FUNDED_AI_SCOPE, issuedAt: at.toISOString(), expiresAt: new Date(expiry).toISOString() };
  await db.executor.insertInto('ai_runtime_credentials').values({ token_id: tokenId, token_hash: qualifiedTokenHash(token, input.hashSecret),
    owner_id: machine.ownerId, machine_id: machine.machineId, runtime_slot: machine.runtimeSlot, audience: credential.audience, scope: credential.scope,
    issued_at: credential.issuedAt, expires_at: credential.expiresAt, revoked_at: null, request_class: requestClass }).execute();
  const binding: GoogleQualifiedFundedBinding = { ...route, requestClass };
  await insertAiFundedRouteBinding(db.executor as Transaction<PlatformDatabase>, { identity: { ownerId: machine.ownerId, machineId: machine.machineId, runtimeSlot: machine.runtimeSlot }, tokenId, binding }, input.now);
  const lease: GoogleQualifiedFundedLease = { contractVersion: 1, credential, identity: { ownerId: machine.ownerId, machineId: machine.machineId, runtimeSlot: machine.runtimeSlot }, policy: input.policy.policy, requestClass };
  return { lease, binding };
}
export async function authenticatedQualifiedToken(db: PlatformDB, token: string, hashSecret: string, lock = false) {
  const parsed = parseGoogleQualifiedFundedCredential(token); if (!parsed) deny();
  let query = db.executor.selectFrom('ai_runtime_credentials').selectAll().where('token_id', '=', parsed.tokenId);
  if (lock) query = query.forShare(); const row = await query.executeTakeFirst();
  const expected = qualifiedTokenHash(token, hashSecret);
  if (!row || !/^[a-f0-9]{64}$/.test(row.token_hash) || !timingSafeEqual(Buffer.from(row.token_hash, 'hex'), Buffer.from(expected, 'hex'))
    || row.audience !== FUNDED_AI_AUDIENCE || row.scope !== FUNDED_AI_SCOPE) deny();
  // Only after complete token authentication, decode actual runtime authorization metadata (not provider identity).
  const actualEpoch = parseQualifiedIssuanceEpoch(row.token_id);
  return { row, epoch: actualEpoch, identity: { ownerId: row.owner_id, machineId: row.machine_id, runtimeSlot: row.runtime_slot } };
}
