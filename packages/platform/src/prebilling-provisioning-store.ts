import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { z } from 'zod/v4';
import type { MatrixBillingInterval, MatrixBillingPlanSlug } from './billing.js';
import { insertProviderDeletion, type PlatformDB, type PrebillingProvisioningIntentsTable } from './db.js';
import {
  canonicalizeDeveloperTools,
  parseDeveloperToolsJson,
  serializeDeveloperTools,
  type DeveloperToolId,
} from './developer-tools.js';

const PrebillingIntentStateSchema = z.enum([
  'awaiting_checkout',
  'preparing',
  'ready_waiting_for_billing',
  'payment_settling',
  'preparation_failed',
  'preparation_deferred',
  'cleanup_pending',
  'checkout_failed',
  'authorized',
  'cleaned',
]);

export type PrebillingIntentState = z.infer<typeof PrebillingIntentStateSchema>;

export interface PrebillingProvisioningIntent {
  id: string;
  checkoutAttemptId: string;
  clerkUserId: string;
  runtimeSlot: string;
  planSlug: MatrixBillingPlanSlug;
  billingInterval: MatrixBillingInterval;
  serverType: string;
  regionSlug: string;
  developerTools: DeveloperToolId[];
  state: PrebillingIntentState;
  revision: number;
  machineId: string | null;
  stripeSessionId: string | null;
  stripeSessionExpiresAt: string | null;
  leaseExpiresAt: string | null;
  paymentConfirmedAt: string | null;
  authorizedAt: string | null;
  cleanedAt: string | null;
  lastErrorCode: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NewPrebillingIntent {
  id: string;
  checkoutAttemptId: string;
  clerkUserId: string;
  runtimeSlot: 'primary';
  planSlug: MatrixBillingPlanSlug;
  billingInterval: MatrixBillingInterval;
  serverType: string;
  regionSlug: string;
  developerTools: DeveloperToolId[];
  createdAt: string;
}

const ACTIVE_CAPACITY_STATES: PrebillingIntentState[] = [
  'preparing',
  'ready_waiting_for_billing',
  'payment_settling',
  'preparation_failed',
  'cleanup_pending',
];

function mapIntent(row: PrebillingProvisioningIntentsTable): PrebillingProvisioningIntent {
  return {
    id: row.id,
    checkoutAttemptId: row.checkout_attempt_id,
    clerkUserId: row.clerk_user_id,
    runtimeSlot: row.runtime_slot,
    planSlug: z.enum(['matrix_starter', 'matrix_builder', 'matrix_max']).parse(row.plan_slug),
    billingInterval: z.enum(['monthly', 'annual']).parse(row.billing_interval),
    serverType: row.server_type,
    regionSlug: row.region_slug,
    developerTools: parseDeveloperToolsJson(row.developer_tools),
    state: PrebillingIntentStateSchema.parse(row.state),
    revision: row.revision,
    machineId: row.machine_id,
    stripeSessionId: row.stripe_session_id,
    stripeSessionExpiresAt: row.stripe_session_expires_at,
    leaseExpiresAt: row.lease_expires_at,
    paymentConfirmedAt: row.payment_confirmed_at,
    authorizedAt: row.authorized_at,
    cleanedAt: row.cleaned_at,
    lastErrorCode: row.last_error_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function selectionMatches(intent: PrebillingProvisioningIntent, input: NewPrebillingIntent): boolean {
  return intent.clerkUserId === input.clerkUserId
    && intent.runtimeSlot === input.runtimeSlot
    && intent.planSlug === input.planSlug
    && intent.billingInterval === input.billingInterval
    && intent.serverType === input.serverType
    && intent.regionSlug === input.regionSlug
    && serializeDeveloperTools(intent.developerTools) === serializeDeveloperTools(input.developerTools);
}

export async function getPrebillingIntentByCheckoutAttempt(
  db: PlatformDB,
  checkoutAttemptId: string,
): Promise<PrebillingProvisioningIntent | undefined> {
  await db.ready;
  const row = await db.executor.selectFrom('prebilling_provisioning_intents').selectAll()
    .where('checkout_attempt_id', '=', checkoutAttemptId).executeTakeFirst();
  return row ? mapIntent(row) : undefined;
}

export async function getPrebillingIntent(
  db: PlatformDB,
  intentId: string,
): Promise<PrebillingProvisioningIntent | undefined> {
  await db.ready;
  const row = await db.executor.selectFrom('prebilling_provisioning_intents').selectAll()
    .where('id', '=', intentId).executeTakeFirst();
  return row ? mapIntent(row) : undefined;
}

export async function listAuthorizedPrebillingFallbackIntents(
  db: PlatformDB,
  now: string,
  limit = 20,
): Promise<PrebillingProvisioningIntent[]> {
  await db.ready;
  const rows = await db.executor.selectFrom('prebilling_provisioning_intents').selectAll()
    .where('state', '=', 'authorized').where('machine_id', 'is', null)
    .where((eb) => eb.or([eb('lease_expires_at', 'is', null), eb('lease_expires_at', '<=', now)]))
    .orderBy('authorized_at', 'asc').limit(Math.max(1, Math.min(100, Math.trunc(limit)))).execute();
  return rows.map(mapIntent);
}

export async function claimAuthorizedPrebillingFallbackIntent(
  db: PlatformDB,
  input: { intentId: string; now: string; leaseExpiresAt: string },
): Promise<PrebillingProvisioningIntent | undefined> {
  await db.ready;
  const row = await db.executor.updateTable('prebilling_provisioning_intents').set({
    lease_expires_at: input.leaseExpiresAt, updated_at: input.now,
  }).where('id', '=', input.intentId).where('state', '=', 'authorized').where('machine_id', 'is', null)
    .where((eb) => eb.or([eb('lease_expires_at', 'is', null), eb('lease_expires_at', '<=', input.now)]))
    .returningAll().executeTakeFirst();
  return row ? mapIntent(row) : undefined;
}

export async function releaseAuthorizedPrebillingFallbackClaim(
  db: PlatformDB,
  input: { intentId: string; leaseExpiresAt: string; now: string },
): Promise<void> {
  await db.ready;
  await db.executor.updateTable('prebilling_provisioning_intents').set({ lease_expires_at: null, updated_at: input.now })
    .where('id', '=', input.intentId).where('state', '=', 'authorized')
    .where('machine_id', 'is', null).where('lease_expires_at', '=', input.leaseExpiresAt).execute();
}

export async function bindAuthorizedPrebillingFallbackMachine(
  db: PlatformDB,
  input: { intentId: string; clerkUserId: string; runtimeSlot: string; machineId: string; leaseExpiresAt: string; now: string },
): Promise<boolean> {
  await db.ready;
  const result = await sql<{ id: string }>`UPDATE prebilling_provisioning_intents SET machine_id = ${input.machineId}, revision = revision + 1, updated_at = ${input.now}
    WHERE id = ${input.intentId} AND clerk_user_id = ${input.clerkUserId} AND runtime_slot = ${input.runtimeSlot} AND state = 'authorized' AND lease_expires_at = ${input.leaseExpiresAt}
      AND (machine_id IS NULL OR machine_id = ${input.machineId}) AND EXISTS (SELECT 1 FROM user_machines WHERE machine_id = ${input.machineId}
        AND clerk_user_id = ${input.clerkUserId} AND runtime_slot = ${input.runtimeSlot} AND activation_state = 'authorized' AND deleted_at IS NULL)
    RETURNING id`.execute(db.executor);
  return result.rows.length === 1;
}

export async function getActivePrebillingIntent(
  db: PlatformDB,
  clerkUserId: string,
  runtimeSlot = 'primary',
): Promise<PrebillingProvisioningIntent | undefined> {
  await db.ready;
  const row = await db.executor.selectFrom('prebilling_provisioning_intents').selectAll()
    .where('clerk_user_id', '=', clerkUserId).where('runtime_slot', '=', runtimeSlot)
    .where('state', 'in', [
      'awaiting_checkout', 'preparing', 'ready_waiting_for_billing',
      'payment_settling', 'preparation_failed', 'preparation_deferred', 'cleanup_pending',
    ]).orderBy('created_at', 'desc').executeTakeFirst();
  return row ? mapIntent(row) : undefined;
}

export async function listPaidPrebillingIntentsNeedingPreparation(
  db: PlatformDB,
  updatedBefore: string,
  limit = 20,
): Promise<PrebillingProvisioningIntent[]> {
  await db.ready;
  const rows = await db.executor.selectFrom('prebilling_provisioning_intents').selectAll()
    .where('payment_confirmed_at', 'is not', null)
    .where('state', 'in', ['payment_settling', 'preparation_failed'])
    .where('updated_at', '<=', updatedBefore)
    .where((eb) => eb.or([
      eb('machine_id', 'is', null),
      eb.exists(
        eb.selectFrom('user_machines as machine').select('machine.machine_id')
          .whereRef('machine.machine_id', '=', 'prebilling_provisioning_intents.machine_id')
          .where('machine.status', '=', 'failed')
          .where('machine.deleted_at', 'is', null),
      ),
    ]))
    .orderBy('updated_at', 'asc')
    .limit(Math.max(1, Math.min(100, Math.trunc(limit))))
    .execute();
  return rows.map(mapIntent);
}

export async function createPrebillingIntent(
  db: PlatformDB,
  input: NewPrebillingIntent,
): Promise<{ intent: PrebillingProvisioningIntent; created: boolean; selectionMatches: boolean }> {
  await db.ready;
  const developerTools = canonicalizeDeveloperTools(input.developerTools);
  const inserted = await db.executor.insertInto('prebilling_provisioning_intents').values({
    id: input.id,
    checkout_attempt_id: input.checkoutAttemptId,
    clerk_user_id: input.clerkUserId,
    runtime_slot: input.runtimeSlot,
    plan_slug: input.planSlug,
    billing_interval: input.billingInterval,
    server_type: input.serverType,
    region_slug: input.regionSlug,
    developer_tools: serializeDeveloperTools(developerTools),
    state: 'awaiting_checkout',
    revision: 1,
    machine_id: null,
    stripe_session_id: null,
    stripe_session_expires_at: null,
    lease_expires_at: null,
    reserved_hourly_cost_micros: 0,
    cleanup_claimed_at: null,
    cleanup_lease_expires_at: null,
    ready_at: null,
    payment_confirmed_at: null,
    authorized_at: null,
    cleaned_at: null,
    last_error_code: null,
    created_at: input.createdAt,
    updated_at: input.createdAt,
  }).onConflict((oc) => oc.doNothing()).returningAll().executeTakeFirst();
  if (inserted) return { intent: mapIntent(inserted), created: true, selectionMatches: true };
  const existing = await getPrebillingIntentByCheckoutAttempt(db, input.checkoutAttemptId)
    ?? await getActivePrebillingIntent(db, input.clerkUserId, input.runtimeSlot);
  if (!existing) throw new Error('prebilling_intent_conflict_unresolved');
  return { intent: existing, created: false, selectionMatches: selectionMatches(existing, input) };
}

export async function admitPrebillingIntent(
  db: PlatformDB,
  input: {
    intentId: string;
    stripeSessionId: string;
    stripeSessionExpiresAt: string;
    maxActive: number;
    now: string;
  },
): Promise<{ intent: PrebillingProvisioningIntent; admitted: boolean; reason: 'admitted' | 'capacity' }> {
  return db.transaction(async (trx) => {
    await sql`SELECT pg_advisory_xact_lock(hashtext('prebilling-provisioning-capacity'))`.execute(trx.executor);
    const current = await trx.executor.selectFrom('prebilling_provisioning_intents').selectAll()
      .where('id', '=', input.intentId).forUpdate().executeTakeFirstOrThrow();
    const currentIntent = mapIntent(current);
    if (currentIntent.state === 'preparing') {
      return { intent: currentIntent, admitted: true, reason: 'admitted' as const };
    }
    if (
      currentIntent.paymentConfirmedAt !== null
      && ['awaiting_checkout', 'payment_settling', 'preparation_failed', 'preparation_deferred']
        .includes(currentIntent.state)
    ) {
      const row = await trx.executor.updateTable('prebilling_provisioning_intents').set({
        state: 'payment_settling',
        stripe_session_id: currentIntent.stripeSessionId ?? input.stripeSessionId,
        stripe_session_expires_at: currentIntent.stripeSessionExpiresAt ?? input.stripeSessionExpiresAt,
        lease_expires_at: null,
        reserved_hourly_cost_micros: 0,
        last_error_code: null,
        revision: current.revision + 1,
        updated_at: input.now,
      }).where('id', '=', input.intentId)
        .where('revision', '=', current.revision)
        .where('payment_confirmed_at', 'is not', null)
        .returningAll().executeTakeFirstOrThrow();
      return { intent: mapIntent(row), admitted: true, reason: 'admitted' as const };
    }
    if (currentIntent.state !== 'awaiting_checkout') {
      return { intent: currentIntent, admitted: false, reason: 'capacity' as const };
    }
    const totals = await sql<{ active_count: string }>`
      SELECT COUNT(*)::text AS active_count
      FROM prebilling_provisioning_intents
      WHERE state IN (${sql.join(ACTIVE_CAPACITY_STATES)})
        AND payment_confirmed_at IS NULL
    `.execute(trx.executor);
    const activeCount = Number(totals.rows[0]?.active_count ?? 0);
    const admitted = activeCount < input.maxActive;
    const row = await trx.executor.updateTable('prebilling_provisioning_intents').set({
      state: admitted ? 'preparing' : 'preparation_deferred',
      stripe_session_id: input.stripeSessionId,
      stripe_session_expires_at: input.stripeSessionExpiresAt,
      lease_expires_at: input.stripeSessionExpiresAt,
      // The retained column is schema compatibility only. A cost-aware rollback
      // must pause admission and drain active zero-valued rows before restoring
      // its monetary ceiling; the shared count fence remains safe while draining.
      reserved_hourly_cost_micros: 0,
      revision: current.revision + 1,
      updated_at: input.now,
    }).where('id', '=', input.intentId).where('revision', '=', current.revision)
      .where('state', '=', 'awaiting_checkout').returningAll().executeTakeFirstOrThrow();
    return { intent: mapIntent(row), admitted, reason: admitted ? 'admitted' : 'capacity' };
  });
}

export async function validatePrebillingProvisioningIntent(
  db: PlatformDB,
  input: {
    intentId: string;
    clerkUserId: string;
    runtimeSlot: string;
    serverType: string;
    regionSlug: string;
    developerTools: DeveloperToolId[];
    now: string;
    machineId?: string;
  },
): Promise<PrebillingProvisioningIntent | undefined> {
  await db.ready;
  const row = await db.executor.selectFrom('prebilling_provisioning_intents').selectAll()
    .where('id', '=', input.intentId).executeTakeFirst();
  if (!row) return undefined;
  const intent = mapIntent(row);
  const leaseIsValid = intent.state === 'authorized'
    || (intent.state === 'payment_settling' && intent.paymentConfirmedAt !== null)
    || (intent.state === 'preparing'
      && intent.leaseExpiresAt !== null
      && Date.parse(intent.leaseExpiresAt) > Date.parse(input.now));
  if (!leaseIsValid
    || intent.clerkUserId !== input.clerkUserId
    || intent.runtimeSlot !== input.runtimeSlot
    || intent.serverType !== input.serverType
    || intent.regionSlug !== input.regionSlug
    || (input.machineId !== undefined && intent.machineId !== input.machineId)
    || serializeDeveloperTools(intent.developerTools)
      !== serializeDeveloperTools(canonicalizeDeveloperTools(input.developerTools))) {
    return undefined;
  }
  return intent;
}

export async function bindPrebillingIntentMachine(
  db: PlatformDB,
  input: { intentId: string; machineId: string; expectedRevision: number; now: string },
): Promise<boolean> {
  await db.ready;
  const row = await db.executor.updateTable('prebilling_provisioning_intents').set({
    machine_id: input.machineId,
    revision: input.expectedRevision + 1,
    updated_at: input.now,
  }).where('id', '=', input.intentId)
    .where('state', 'in', ['preparing', 'payment_settling'])
    .where('revision', '=', input.expectedRevision)
    .where((eb) => eb.or([
      eb('machine_id', 'is', null),
      eb.exists(
        eb.selectFrom('user_machines').select('machine_id')
          .whereRef('user_machines.machine_id', '=', 'prebilling_provisioning_intents.machine_id')
          .where('user_machines.deleted_at', 'is not', null),
      ),
    ]))
    .returning('id').executeTakeFirst();
  return Boolean(row);
}

/** Marks an exact fenced machine ready only after its registration transaction
 * has made the machine running. The intent and machine transition together, so
 * checkout can never observe readiness ahead of durable runtime registration. */
export async function markPrebillingIntentReady(
  db: PlatformDB,
  input: {
    intentId: string;
    machineId: string;
    clerkUserId: string;
    runtimeSlot: string;
    now: string;
  },
): Promise<boolean> {
  await db.ready;
  const updated = await sql<{ ready: boolean }>`
    WITH eligible AS (
      SELECT intent.id, intent.payment_confirmed_at
      FROM prebilling_provisioning_intents AS intent
      WHERE intent.id = ${input.intentId}
        AND intent.machine_id = ${input.machineId}
        AND intent.clerk_user_id = ${input.clerkUserId}
        AND intent.runtime_slot = ${input.runtimeSlot}
        AND intent.state IN ('preparing', 'payment_settling')
        AND EXISTS (
          SELECT 1
          FROM user_machines AS machine
          WHERE machine.machine_id = ${input.machineId}
            AND machine.prebilling_intent_id = intent.id
            AND machine.clerk_user_id = intent.clerk_user_id
            AND machine.runtime_slot = intent.runtime_slot
            AND machine.status = 'running'
            AND machine.activation_state = 'awaiting_billing'
            AND machine.deleted_at IS NULL
        )
      FOR UPDATE
    ), activated AS (
      UPDATE user_machines AS machine
      SET activation_state = CASE
            WHEN eligible.payment_confirmed_at IS NOT NULL THEN 'authorized'
            ELSE machine.activation_state
          END,
          activation_authorized_at = CASE
            WHEN eligible.payment_confirmed_at IS NOT NULL
              THEN COALESCE(machine.activation_authorized_at, ${input.now})
            ELSE machine.activation_authorized_at
          END
      FROM eligible
      WHERE machine.machine_id = ${input.machineId}
        AND machine.prebilling_intent_id = eligible.id
        AND machine.clerk_user_id = ${input.clerkUserId}
        AND machine.runtime_slot = ${input.runtimeSlot}
        AND machine.status = 'running'
        AND machine.activation_state = 'awaiting_billing'
        AND machine.deleted_at IS NULL
      RETURNING machine.machine_id
    ), marked AS (
      UPDATE prebilling_provisioning_intents AS intent
      SET state = CASE
            WHEN eligible.payment_confirmed_at IS NOT NULL THEN 'authorized'
            ELSE 'ready_waiting_for_billing'
          END,
          ready_at = COALESCE(intent.ready_at, ${input.now}),
          authorized_at = CASE
            WHEN eligible.payment_confirmed_at IS NOT NULL
              THEN COALESCE(intent.authorized_at, ${input.now})
            ELSE intent.authorized_at
          END,
          lease_expires_at = CASE
            WHEN eligible.payment_confirmed_at IS NOT NULL THEN NULL
            ELSE intent.lease_expires_at
          END,
          reserved_hourly_cost_micros = 0,
          revision = intent.revision + 1,
          updated_at = ${input.now}
      FROM eligible, activated
      WHERE intent.id = eligible.id
        AND activated.machine_id = ${input.machineId}
      RETURNING intent.id
    )
    SELECT EXISTS(SELECT 1 FROM marked) OR EXISTS(
      SELECT 1
      FROM prebilling_provisioning_intents AS intent
      JOIN user_machines AS machine ON machine.machine_id = intent.machine_id
      WHERE intent.id = ${input.intentId}
        AND intent.machine_id = ${input.machineId}
        AND intent.clerk_user_id = ${input.clerkUserId}
        AND intent.runtime_slot = ${input.runtimeSlot}
        AND intent.state IN ('ready_waiting_for_billing', 'authorized')
        AND machine.status = 'running'
        AND machine.activation_state = CASE
          WHEN intent.state = 'authorized' THEN 'authorized'
          ELSE 'awaiting_billing'
        END
        AND machine.deleted_at IS NULL
    ) AS ready
  `.execute(db.executor);
  return updated.rows[0]?.ready ?? false;
}

export async function markPrebillingPreparationFailed(
  db: PlatformDB,
  input: { intentId: string; now: string; errorCode: string },
): Promise<boolean> {
  await db.ready;
  const updated = await db.executor.updateTable('prebilling_provisioning_intents').set((eb) => ({
    state: 'preparation_failed',
    reserved_hourly_cost_micros: 0,
    last_error_code: input.errorCode.slice(0, 64),
    revision: eb('revision', '+', 1),
    updated_at: input.now,
  })).where('id', '=', input.intentId)
    .where('state', 'in', ['preparing', 'payment_settling'])
    .returning('id').executeTakeFirst();
  return Boolean(updated);
}

export async function resetPrebillingPreparationForRetry(
  db: PlatformDB,
  input: { intentId: string; clerkUserId: string; now: string },
): Promise<boolean> {
  await db.ready;
  const updated = await db.executor.updateTable('prebilling_provisioning_intents').set((eb) => ({
    state: 'awaiting_checkout',
    reserved_hourly_cost_micros: 0,
    last_error_code: null,
    revision: eb('revision', '+', 1),
    updated_at: input.now,
  })).where('id', '=', input.intentId)
    .where('clerk_user_id', '=', input.clerkUserId)
    .where('state', 'in', ['preparation_failed', 'preparation_deferred'])
    .where('payment_confirmed_at', 'is', null)
    .where('stripe_session_id', 'is not', null)
    .where('stripe_session_expires_at', '>', input.now)
    .returning('id').executeTakeFirst();
  return Boolean(updated);
}

/** Must be called inside the signed billing projection transaction. */
export async function authorizePrebillingIntent(
  db: PlatformDB,
  input: { intentId: string; clerkUserId: string; runtimeSlot: string; now: string },
): Promise<{ authorized: boolean; machineId: string | null }> {
  await db.ready;
  const current = await db.executor.selectFrom('prebilling_provisioning_intents').selectAll()
    .where('id', '=', input.intentId)
    .where('clerk_user_id', '=', input.clerkUserId)
    .where('runtime_slot', '=', input.runtimeSlot)
    .forUpdate().executeTakeFirst();
  if (!current) throw new Error('prebilling_intent_not_found');
  const intent = mapIntent(current);
  if (intent.state === 'authorized') {
    if (!intent.machineId) throw new Error('prebilling_machine_not_ready');
    return { authorized: true, machineId: intent.machineId };
  }
  if (intent.state !== 'ready_waiting_for_billing' || !intent.machineId) {
    if (![
      'awaiting_checkout',
      'preparing',
      'payment_settling',
      'preparation_failed',
      'preparation_deferred',
    ].includes(intent.state)) {
      throw new Error('prebilling_intent_not_payable');
    }
    if (intent.state !== 'payment_settling' || intent.paymentConfirmedAt === null) {
      const settling = await db.executor.updateTable('prebilling_provisioning_intents').set({
        state: 'payment_settling',
        payment_confirmed_at: intent.paymentConfirmedAt ?? input.now,
        lease_expires_at: null,
        reserved_hourly_cost_micros: 0,
        revision: intent.revision + 1,
        updated_at: input.now,
      }).where('id', '=', intent.id).where('revision', '=', intent.revision)
        .returning('id').executeTakeFirst();
      if (!settling) throw new Error('prebilling_payment_settling_conflict');
    }
    return { authorized: false, machineId: intent.machineId };
  }
  const activated = await db.executor.updateTable('user_machines').set({
    activation_state: 'authorized',
    activation_authorized_at: input.now,
  }).where('machine_id', '=', intent.machineId)
    .where('prebilling_intent_id', '=', intent.id)
    .where('clerk_user_id', '=', input.clerkUserId)
    .where('runtime_slot', '=', input.runtimeSlot)
    .where('status', '=', 'running')
    .where('activation_state', '=', 'awaiting_billing')
    .returning('machine_id').executeTakeFirst();
  if (!activated) throw new Error('prebilling_machine_activation_mismatch');
  const authorized = await db.executor.updateTable('prebilling_provisioning_intents').set({
    state: 'authorized',
    payment_confirmed_at: intent.paymentConfirmedAt ?? input.now,
    authorized_at: input.now,
    lease_expires_at: null,
    reserved_hourly_cost_micros: 0,
    revision: intent.revision + 1,
    updated_at: input.now,
  }).where('id', '=', intent.id).where('revision', '=', intent.revision)
    .returning('id').executeTakeFirst();
  if (!authorized) throw new Error('prebilling_authorization_conflict');
  return { authorized: true, machineId: intent.machineId };
}

/** Must be called inside the verified Stripe webhook transaction. */
export async function cleanupExpiredPrebillingCheckout(
  db: PlatformDB,
  input: { stripeSessionId: string; intentId?: string; clerkUserId?: string; now: string },
): Promise<{ cleaned: boolean; intentId: string | null }> {
  await db.ready;
  const current = await db.executor.selectFrom('prebilling_provisioning_intents').selectAll()
    .where((eb) => input.intentId
      ? eb.or([
          eb('stripe_session_id', '=', input.stripeSessionId),
          eb.and([
            eb('id', '=', input.intentId),
            ...(input.clerkUserId ? [eb('clerk_user_id', '=', input.clerkUserId)] : []),
            eb('stripe_session_id', 'is', null),
          ]),
        ])
      : eb('stripe_session_id', '=', input.stripeSessionId))
    .forUpdate().executeTakeFirst();
  if (!current) return { cleaned: false, intentId: null };
  const intent = mapIntent(current);
  if (intent.paymentConfirmedAt !== null || intent.state === 'authorized' || intent.state === 'cleaned') {
    return { cleaned: false, intentId: intent.id };
  }
  if (intent.machineId) {
    const machine = await db.executor.selectFrom('user_machines').selectAll()
      .where('machine_id', '=', intent.machineId).forUpdate().executeTakeFirst();
    if (machine && machine.activation_state !== 'authorized' && machine.deleted_at === null) {
      await db.executor.updateTable('user_machines').set({
        status: 'deleted',
        deleted_at: input.now,
        registration_token_hash: null,
        registration_token_expires_at: null,
        failure_code: 'checkout_expired',
        failure_at: input.now,
      }).where('machine_id', '=', machine.machine_id)
        .where('activation_state', '=', 'awaiting_billing').execute();
      await db.executor.updateTable('provisioning_jobs').set({
        status: 'failed',
        encrypted_payload: null,
        last_error_code: 'checkout_expired',
        updated_at: input.now,
        completed_at: input.now,
      }).where('machine_id', '=', machine.machine_id)
        .where('status', 'in', ['queued', 'running']).execute();
      if (machine.hetzner_server_id !== null) {
        await insertProviderDeletion(db, {
          id: randomUUID(),
          providerServerId: machine.hetzner_server_id,
          reason: 'prebilling_checkout_expired',
          machineId: machine.machine_id,
          handle: machine.handle,
          nextAttemptAt: input.now,
          createdAt: input.now,
        });
      }
    } else if (machine?.activation_state === 'authorized') {
      return { cleaned: false, intentId: intent.id };
    }
  }
  const cleaned = await db.executor.updateTable('prebilling_provisioning_intents').set({
    state: 'cleaned',
    machine_id: null,
    cleaned_at: input.now,
    lease_expires_at: null,
    reserved_hourly_cost_micros: 0,
    revision: intent.revision + 1,
    updated_at: input.now,
  }).where('id', '=', intent.id).where('revision', '=', intent.revision)
    .where('state', '!=', 'authorized').returning('id').executeTakeFirst();
  if (!cleaned) throw new Error('prebilling_cleanup_conflict');
  return { cleaned: true, intentId: intent.id };
}
