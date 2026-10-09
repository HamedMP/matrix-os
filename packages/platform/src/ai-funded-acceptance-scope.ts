import { z } from 'zod/v4';
import { sql } from 'kysely';
import type { PlatformDB } from './db.js';
import { RuntimeSlotSchema } from './customer-vps-schema.js';
import { AiFundedPolicyError } from './ai-funded-policy-errors.js';
const ScopeSchema = z.object({
  ownerId: z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/),
  machineId: z.uuid(), runtimeSlot: RuntimeSlotSchema, runtimeTokenEpoch: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  validThrough: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
}).strict();
export type FundedAcceptanceScope = Readonly<z.infer<typeof ScopeSchema>>;
export type AcceptanceIdentity = {
  ownerId: string;
  machineId: string;
  runtimeSlot: string;
};
/** Expired well-formed scopes remain present after restart; never unscoped fallback. */
export function validateFundedAcceptanceScope(value: unknown, now = new Date()): FundedAcceptanceScope {
  const scope = ScopeSchema.parse(value);
  const expiry = Date.parse(scope.validThrough);
  if (!Number.isFinite(expiry) || new Date(expiry).toISOString() !== scope.validThrough || expiry - now.getTime() > 3600000)
    throw new Error('Funded acceptance scope is misconfigured');
  return Object.freeze(scope);
}
/** New optional local deployment setting, not an existing production flag. */
export function loadFundedAcceptanceScope(env: NodeJS.ProcessEnv, now = new Date()): FundedAcceptanceScope | undefined {
  if (env.MATRIX_FUNDED_AI_ACCEPTANCE_SCOPE === undefined)
    return undefined;
  const raw = env.MATRIX_FUNDED_AI_ACCEPTANCE_SCOPE;
  if (Buffer.byteLength(raw, 'utf8') > 2048 || env.MATRIX_FUNDED_AI_CONTROL_PLANE_ENABLED !== 'true'
    || env.PLATFORM_BACKGROUND_WORKERS_ENABLED !== 'false'
    || ['MATRIX_FUNDED_AI_RUNTIME_ENABLED', 'MATRIX_FUNDED_HOST_CONFIG_ENABLED', 'MATRIX_FUNDED_AI_ADDON_CHECKOUT_ENABLED', 'AI_FUNDED_PROMOTIONAL_GRANT_ENABLED'].some(name => env[name] !== undefined && env[name] !== 'false'))
    throw new Error('Funded acceptance composition is misconfigured');
  return validateFundedAcceptanceScope(JSON.parse(raw), now);
}
export function assertFundedAcceptanceIdentity(scope: FundedAcceptanceScope | undefined, identity: AcceptanceIdentity, epoch: number | undefined, now: Date): void {
  if (!scope)
    return;
  if (scope.ownerId !== identity.ownerId || scope.machineId !== identity.machineId || scope.runtimeSlot !== identity.runtimeSlot
    || scope.runtimeTokenEpoch !== epoch || now.getTime() >= Date.parse(scope.validThrough))
    throw new AiFundedPolicyError('access_disabled');
}
export function assertAcceptanceIdentityMember(scope: FundedAcceptanceScope | undefined, identity: AcceptanceIdentity, now: Date): void {
  assertFundedAcceptanceIdentity(scope, identity, scope?.runtimeTokenEpoch, now);
}
/** SQL predicate evaluated by PostgreSQL in the actual credential issue statement. */
export function acceptanceMachineSql(scope: FundedAcceptanceScope | undefined, alias: 'machine' | 'user_machines' = 'machine') {
  if (!scope)
    return sql<boolean> `true`;
  return sql<boolean> `${sql.ref(`${alias}.machine_id`)} = ${scope.machineId}
 and ${sql.ref(`${alias}.clerk_user_id`)} = ${scope.ownerId}
 and ${sql.ref(`${alias}.runtime_slot`)} = ${scope.runtimeSlot}
 and ${sql.ref(`${alias}.runtime_token_epoch`)} = ${scope.runtimeTokenEpoch}
 and ${sql.ref(`${alias}.status`)} = 'running'
 and ${sql.ref(`${alias}.activation_state`)} = 'authorized'
 and ${sql.ref(`${alias}.deleted_at`)} is null
 and clock_timestamp() < ${scope.validThrough}::timestamptz`;
}
/** Read is an admission observation, not an HTTP lock. Mutating callers hold this
* row FOR SHARE through their transaction, before dependent mutable row locks. */
export async function readAcceptanceMachine(db: PlatformDB, scope: FundedAcceptanceScope, identity: AcceptanceIdentity, now: () => Date, lock = false) {
  assertAcceptanceIdentityMember(scope, identity, now());
  let query = db.executor.selectFrom('user_machines').select([
    'machine_id', 'clerk_user_id', 'runtime_slot', 'runtime_token_epoch', 'status', 'activation_state', 'deleted_at'
  ])
    .where('machine_id', '=', identity.machineId);
  if (lock)
    query = query.forShare();
  const machine = await query.executeTakeFirst();
  if (!machine || machine.clerk_user_id !== identity.ownerId || machine.runtime_slot !== identity.runtimeSlot
    || machine.status !== 'running' || machine.activation_state !== 'authorized' || machine.deleted_at !== null)
    throw new AiFundedPolicyError('access_disabled');
  assertFundedAcceptanceIdentity(scope, identity, machine.runtime_token_epoch, now());
  return machine;
}
/** Final DB-clock fence rolls back transaction writes if the scope expired while
* waiting for locks; no locks are held over provider HTTP. */
export async function assertAcceptanceTransactionCurrent(db: PlatformDB, scope: FundedAcceptanceScope | undefined, now: () => Date): Promise<void> {
  if (!scope)
    return;
  assertAcceptanceIdentityMember(scope, scope, now());
  const result = await sql<{
    allowed: boolean;
  }> `select clock_timestamp() < ${scope.validThrough}::timestamptz as allowed`.execute(db.executor);
  if (result.rows[0]?.allowed !== true)
    throw new AiFundedPolicyError('access_disabled');
}
export function denyAcceptanceOperatorWrite(scope: FundedAcceptanceScope | undefined): void {
  if (scope)
    throw new AiFundedPolicyError('access_disabled');
}
