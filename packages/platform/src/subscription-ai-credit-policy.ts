import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import { z } from 'zod/v4';
import { FundedAiIdentitySchema, IsoTimestampSchema } from '@matrix-os/contracts';
import type { PlatformDB } from './db.js';
import type { AiFundedPolicyRepository } from './ai-funded-policy-repository.js';
import { withAccountDeletionOwnerLock } from './account-deletion/admission.js';
import { intersectModels, parseModels } from './ai-funded-metering-helpers.js';

const RuleSchema = z.object({
  amountMicrousd: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  cadence: z.enum(['once', 'calendar_month']),
  expiry: z.enum(['never', 'cycle_end']),
}).strict().refine(rule => rule.cadence !== 'once' || rule.expiry === 'never');
const PolicySchema = z.object({
  version: z.string().min(1).max(40).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/),
  plans: z.object({ matrix_starter: RuleSchema.optional(), matrix_builder: RuleSchema.optional(),
    matrix_max: RuleSchema.optional() }).strict().refine(plans => Object.values(plans).some(Boolean)),
}).strict();
export type SubscriptionAiCreditPolicy = { enabled: false } | ({ enabled: true } & z.infer<typeof PolicySchema>);

/** No default tiers, recurrence, expiry or upgrade entitlement. Setting amounts
 * without the explicit flag cannot issue credit. This foundation has no public
 * route, scheduler or automatic webhook/read-side activation. */
export function loadSubscriptionAiCreditPolicy(env: NodeJS.ProcessEnv): SubscriptionAiCreditPolicy {
  if (env.MATRIX_AI_SUBSCRIPTION_CREDIT_ENABLED !== 'true') return { enabled: false };
  const raw = env.MATRIX_AI_SUBSCRIPTION_CREDIT_POLICY_JSON;
  if (!raw || Buffer.byteLength(raw) > 4096) throw new Error('Subscription AI credit configuration is invalid');
  try {
    return { enabled: true, ...PolicySchema.parse(JSON.parse(raw) as unknown) };
  } catch (error: unknown) {
    if (error instanceof SyntaxError || error instanceof z.ZodError) {
      throw new Error('Subscription AI credit configuration is invalid', { cause: error });
    }
    throw error;
  }
}

/** Internal issuer for a future approved orchestration boundary. The plan comes
 * from current billing, never request metadata. Owner/cycle IDs survive delivery,
 * subscription replacement and policy-version changes without minting a refill.
 * Conflicting same-cycle terms fail closed until an upgrade rule is approved. */
export async function issueConfiguredSubscriptionAiCredit(input: {
  db: PlatformDB;
  repository: Pick<AiFundedPolicyRepository, 'grantCreditInTransaction'>;
  identity: z.input<typeof FundedAiIdentitySchema>;
  env: NodeJS.ProcessEnv;
  now: Date;
}): Promise<'disabled' | 'ineligible' | 'accepted'> {
  const config = loadSubscriptionAiCreditPolicy(input.env);
  if (!config.enabled) return 'disabled';
  const identity = FundedAiIdentitySchema.parse(input.identity);
  const at = IsoTimestampSchema.parse(input.now.toISOString());
  if (identity.runtimeSlot !== 'primary') return 'ineligible';
  await input.db.ready;
  return withAccountDeletionOwnerLock(input.db, identity.ownerId, async (trx, admission) => {
    if (!admission.newWorkAllowed) return 'ineligible';
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`funded-ai-owner:${identity.ownerId}`}, 0))`.execute(trx.executor);
    const machine = await trx.executor.selectFrom('user_machines').select([
      'clerk_user_id', 'runtime_slot', 'status', 'activation_state', 'provisioning_class', 'deleted_at',
    ]).where('machine_id', '=', identity.machineId).forUpdate().executeTakeFirst();
    if (!machine || machine.clerk_user_id !== identity.ownerId || machine.runtime_slot !== identity.runtimeSlot
      || machine.status !== 'running' || machine.activation_state !== 'authorized'
      || machine.provisioning_class !== 'customer' || machine.deleted_at !== null) return 'ineligible';
    const runtime = await trx.executor.selectFrom('ai_funded_runtime_policies').select([
      'owner_id', 'runtime_slot', 'enabled', 'expires_at', 'allowed_model_ids',
    ]).where('machine_id', '=', identity.machineId).forUpdate().executeTakeFirst();
    const global = await trx.executor.selectFrom('ai_funded_global_policy').select(['enabled', 'allowed_model_ids'])
      .where('policy_id', '=', 'default').forUpdate().executeTakeFirstOrThrow();
    if (!runtime?.enabled || !global.enabled || runtime.owner_id !== identity.ownerId
      || runtime.runtime_slot !== identity.runtimeSlot || runtime.expires_at !== null && runtime.expires_at <= at
      || intersectModels(parseModels(global.allowed_model_ids), parseModels(runtime.allowed_model_ids)).length === 0) return 'ineligible';
    const subscriptions = await trx.executor.selectFrom('billing_subscriptions')
      .select(['stripe_subscription_id', 'plan_slug']).where('clerk_user_id', '=', identity.ownerId)
      .where('runtime_slot', '=', identity.runtimeSlot).where('status', '=', 'active')
      .where('current_period_end', '>', at).limit(2).forUpdate().execute();
    // Ambiguous multiple active subscriptions require explicit reconciliation.
    if (subscriptions.length !== 1) return 'ineligible';
    const subscription = subscriptions[0]!;
    if (!Object.hasOwn(config.plans, subscription.plan_slug)) return 'ineligible';
    const rule = config.plans[subscription.plan_slug as keyof typeof config.plans];
    if (!rule) return 'ineligible';
    // Until product approves transition rules, even changing cadence must not
    // turn a one-time entitlement into another immediate grant.
    const termsPrefix = `subscription:${subscription.plan_slug}:${rule.cadence}:`;
    const otherTerms = await trx.executor.selectFrom('ai_funded_credit_ledger').select('entry_id')
      .where('owner_id', '=', identity.ownerId).where('runtime_slot', '=', identity.runtimeSlot)
      .where('entry_id', 'like', 'subscription-credit:%')
      .where('source_reference', 'not like', `${termsPrefix}%`).limit(1).executeTakeFirst();
    if (otherTerms) return 'ineligible';
    const year = input.now.getUTCFullYear(), month = input.now.getUTCMonth();
    const cycle = rule.cadence === 'once' ? 'once' : `${year}-${String(month + 1).padStart(2, '0')}`;
    const expiresAt = rule.expiry === 'never' ? null : new Date(Date.UTC(year, month + 1, 1)).toISOString();
    const digest = createHash('sha256').update(`${identity.ownerId}\0${identity.runtimeSlot}\0${cycle}`).digest('hex');
    await input.repository.grantCreditInTransaction(trx, { identity,
      entryId: `subscription-credit:${digest}`, kind: 'promotional_grant', amountMicrousd: rule.amountMicrousd,
      sourceReference: `${termsPrefix}${config.version}:${createHash('sha256').update(subscription.stripe_subscription_id).digest('hex')}`,
      expiresAt,
    }, at);
    return 'accepted';
  }, input.env);
}
