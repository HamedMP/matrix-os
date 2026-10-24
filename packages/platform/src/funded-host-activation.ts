import { FundedHostActivationResponseSchema, MANAGED_WORKERS_AI_MODEL_IDS, type FundedHostActivationResponse } from '@matrix-os/contracts';
import { Hono } from 'hono';
import { sql } from 'kysely';
import { z } from 'zod/v4';
import type { PlatformDB } from './db.js';
import { getAccountDeletionAdmission } from './account-deletion/admission.js';
import { readUsageWaiverAudit, USAGE_WAIVER_MAX_RECORDS } from './ai-funded-usage-waiver-audit.js';
import { buildPlatformRuntimeVerificationToken, timingSafeTokenEquals } from './platform-token.js';
import { isBoundedPreviewProvisioningClass } from './preview-runtime-access.js';

const Handle = z.string().min(1).max(63).regex(/^[a-z0-9][a-z0-9-]*$/);
const RuntimeSlot = z.string().min(1).max(32).regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/);
const Query = z.object({ runtimeSlot: RuntimeSlot.optional().default('primary') }).strict();
const Models = z.array(z.string().max(128)).max(32);
const ordinaryModels = new Set<string>(['anthropic/claude-sonnet-5', ...MANAGED_WORKERS_AI_MODEL_IDS]);
type Options = { db: PlatformDB; platformSecret: string; previewRuntimeSecret?: string;
  relayOrigin: string; now?: () => Date; env?: NodeJS.ProcessEnv };
export type FundedHostActivationRead = { status: 'ready'; configuration: FundedHostActivationResponse }
  | { status: 'unauthorized' | 'ineligible' | 'deferred' };

/** Configuration delivery only: never issues a credential, grants credit or settles usage. */
export async function readFundedHostActivation(options: Options & {
  handle: string; runtimeSlot: string; authorization: string | undefined;
}): Promise<FundedHostActivationRead> {
  const supplied = options.authorization?.startsWith('Bearer ') ? options.authorization.slice(7) : '';
  if (!Handle.safeParse(options.handle).success || !RuntimeSlot.safeParse(options.runtimeSlot).success
    || !/^[a-f0-9]{64}$/.test(supplied)) return { status: 'unauthorized' };
  if (options.platformSecret.length < 32) throw new Error('Managed feature configuration unavailable');
  await options.db.ready;
  return options.db.kysely.transaction().setIsolationLevel('repeatable read').execute(async trx => {
    await sql`SET TRANSACTION READ ONLY`.execute(trx);
    await sql`SET LOCAL statement_timeout = '5000ms'`.execute(trx);
    const machine = await trx.selectFrom('user_machines').selectAll()
      .where('handle', '=', options.handle).where('runtime_slot', '=', options.runtimeSlot)
      .where('status', '=', 'running').where('activation_state', '=', 'authorized')
      .where('provisioning_class', 'in', ['customer', 'preview', 'private-preview'])
      .where('deleted_at', 'is', null).executeTakeFirst();
    if (!machine) return { status: 'unauthorized' };
    const preview = isBoundedPreviewProvisioningClass(machine.provisioning_class);
    if (!preview && (machine.provisioning_class !== 'customer' || machine.runtime_slot !== 'primary')) {
      return { status: 'unauthorized' };
    }
    const runtimeSecret = preview ? options.previewRuntimeSecret : options.platformSecret;
    if (!runtimeSecret || runtimeSecret.length < 32 || (preview && runtimeSecret === options.platformSecret)) {
      return { status: 'unauthorized' };
    }
    const runtimeToken = buildPlatformRuntimeVerificationToken({ handle: machine.handle,
      machineId: machine.machine_id, runtimeSlot: machine.runtime_slot }, runtimeSecret, machine.runtime_token_epoch);
    if (!timingSafeTokenEquals(supplied, runtimeToken)) return { status: 'unauthorized' };
    const now = (options.now ?? (() => new Date()))();
    const deletion = await getAccountDeletionAdmission({ ...options.db, executor: trx }, machine.clerk_user_id, options.env, now);
    if (!deletion.newWorkAllowed) return { status: 'deferred' };
    const policy = await trx.selectFrom('ai_funded_runtime_policies as runtime')
      .innerJoin('ai_funded_global_policy as global', join => join.on('global.policy_id', '=', 'default'))
      .select(['runtime.enabled', 'global.enabled as global_enabled', 'runtime.expires_at',
        'runtime.allowed_model_ids', 'global.allowed_model_ids as global_models'])
      .where('runtime.machine_id', '=', machine.machine_id).where('runtime.owner_id', '=', machine.clerk_user_id)
      .where('runtime.runtime_slot', '=', machine.runtime_slot).executeTakeFirst();
    if (!policy?.enabled || !policy.global_enabled || (policy.expires_at !== null && Date.parse(policy.expires_at) <= now.getTime())) return { status: 'ineligible' };
    const allocation = preview ? await trx.selectFrom('preview_runtime_allocations').selectAll()
      .where('machine_id', '=', machine.machine_id).where('owner_id', '=', machine.clerk_user_id)
      .where('runtime_slot', '=', machine.runtime_slot)
      .where('runtime_token_epoch', '=', machine.runtime_token_epoch)
      .where('expires_at', '>', now.toISOString()).executeTakeFirst() : undefined;
    if (preview && !allocation) return { status: 'ineligible' };
    const runtimeModels = Models.parse(JSON.parse(policy.allowed_model_ids) as unknown);
    const globalModels = Models.parse(JSON.parse(policy.global_models) as unknown);
    if (!runtimeModels.some(model => ordinaryModels.has(model) && globalModels.includes(model))) return { status: 'ineligible' };
    const pending = await trx.selectFrom('ai_funded_usage_reservations').selectAll()
      .where('machine_id', '=', machine.machine_id).where('runtime_slot', '=', machine.runtime_slot)
      .where(eb => eb.or([eb('status', 'not in', ['settled', 'released']),
        eb.and([eb('status', '=', 'settled'), eb('actual_microusd', 'is', null)])]))
      .limit(USAGE_WAIVER_MAX_RECORDS + 1).execute();
    if (pending.length > USAGE_WAIVER_MAX_RECORDS) return { status: 'deferred' };
    for (const row of pending) {
      if (row.status !== 'waived' || row.owner_id !== machine.clerk_user_id) return { status: 'deferred' };
      readUsageWaiverAudit(row);
    }
    const expiresAt = Math.min(now.getTime() + 30_000,
      policy.expires_at === null ? Infinity : Date.parse(policy.expires_at),
      allocation ? Date.parse(allocation.expires_at) : Infinity);
    return { status: 'ready', configuration: FundedHostActivationResponseSchema.parse({ contractVersion: 1,
      identity: { handle: machine.handle, machineId: machine.machine_id, ownerId: machine.clerk_user_id,
        runtimeSlot: machine.runtime_slot, runtimeTokenEpoch: machine.runtime_token_epoch },
      configuration: { enabled: true, platformOrigin: 'https://app.matrix-os.com', relayOrigin: options.relayOrigin, runtimeToken },
      issuedAt: now.toISOString(), expiresAt: new Date(expiresAt).toISOString() }) };
  });
}

export function createFundedHostActivationRoutes(options: Options): Hono {
  if (options.previewRuntimeSecret !== undefined
    && (options.previewRuntimeSecret.length < 32 || options.previewRuntimeSecret === options.platformSecret)) {
    throw new Error('Managed feature configuration unavailable');
  }
  const app = new Hono();
  app.get('/activation-config', async c => {
    c.header('Cache-Control', 'no-store, private');
    c.header('CDN-Cache-Control', 'no-store');
    const query = Query.safeParse(c.req.query());
    if (!query.success || !Handle.safeParse(c.req.param('handle')).success) return c.json({ error: 'Invalid request' }, 400);
    try {
      const result = await readFundedHostActivation({ ...options, handle: c.req.param('handle')!,
        runtimeSlot: query.data.runtimeSlot, authorization: c.req.header('authorization') });
      if (result.status === 'unauthorized') return c.json({ error: 'Unauthorized' }, 401);
      if (result.status !== 'ready') return c.json({ error: 'Service unavailable' }, 503);
      return c.json(result.configuration);
    } catch (error: unknown) {
      console.warn('[managed-features] configuration read failed', error instanceof Error ? error.name : 'UnknownError');
      return c.json({ error: 'Service unavailable' }, 503);
    }
  });
  return app;
}
