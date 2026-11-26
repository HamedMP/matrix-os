import { Hono, type Context, type Env } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import { sql, type ColumnType } from 'kysely';
import { z } from 'zod/v4';
import type { PlatformDB } from '../db.js';
import { timingSafeTokenEquals } from '../platform-token.js';
import type { FreeTierConfig } from './config.js';

/**
 * Free-tier invites and operator administration (spec 2691, ENG-520; ported
 * from PR #3414). Capacity counts admitted free owners and their metal
 * runtimes instead of container runtimes.
 */

export interface FreeTierInvitesTable {
  clerk_user_id: string;
  invited_by: string;
  created_at: ColumnType<Date, Date | string | undefined, never>;
  consumed_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
}

export interface FreeTierInvite {
  clerkUserId: string;
  invitedBy: string;
  createdAt: Date;
  consumedAt: Date | null;
}

export type AddInviteOutcome = 'created' | 'exists';
export type RemoveInviteOutcome = 'removed' | 'not_found' | 'consumed';
export type RedeemInviteOutcome = 'redeemed' | 'already_redeemed' | 'not_invited';

export interface FreeTierCapacity {
  /** Admitted free owners (see countFreeOwners). */
  runtimes: number;
  maxRuntimes: number;
  running: number;
  invitesPending: number;
  inviteRequired: boolean;
}

export const ClerkUserIdParamSchema = z.string().regex(/^user_[A-Za-z0-9]{1,128}$/);
const InvitedBySchema = z.string().regex(/^[A-Za-z0-9._@:-]{1,128}$/);
const AddInviteBodySchema = z.strictObject({ clerkUserId: ClerkUserIdParamSchema, invitedBy: InvitedBySchema });
const EmptyQuerySchema = z.strictObject({});
const OPERATOR_BODY_LIMIT = 4096;
const MIN_OPERATOR_SECRET_LENGTH = 16;

export async function addFreeTierInvite(
  db: PlatformDB,
  input: { clerkUserId: string; invitedBy: string },
): Promise<AddInviteOutcome> {
  const inserted = await db.executor.insertInto('free_tier_invites')
    .values({ clerk_user_id: input.clerkUserId, invited_by: input.invitedBy })
    .onConflict((oc) => oc.column('clerk_user_id').doNothing())
    .returning('clerk_user_id')
    .executeTakeFirst();
  return inserted ? 'created' : 'exists';
}

export async function getFreeTierInvite(db: PlatformDB, clerkUserId: string): Promise<FreeTierInvite | undefined> {
  const row = await db.executor.selectFrom('free_tier_invites').selectAll()
    .where('clerk_user_id', '=', clerkUserId).executeTakeFirst();
  return row
    ? { clerkUserId: row.clerk_user_id, invitedBy: row.invited_by, createdAt: row.created_at, consumedAt: row.consumed_at }
    : undefined;
}

/** Only an unconsumed invite is removed; a consumed one is the record of a runtime that exists. */
export async function removeFreeTierInvite(db: PlatformDB, clerkUserId: string): Promise<RemoveInviteOutcome> {
  const deleted = await db.executor.deleteFrom('free_tier_invites')
    .where('clerk_user_id', '=', clerkUserId)
    .where('consumed_at', 'is', null)
    .returning('clerk_user_id')
    .executeTakeFirst();
  if (deleted) return 'removed';
  return await getFreeTierInvite(db, clerkUserId) ? 'consumed' : 'not_found';
}

/**
 * The guarded UPDATE is the redemption: of any number of concurrent callers,
 * exactly one sees a row returned. Run inside the transaction that admits
 * the owner (stores the free entitlement), so a refusal leaves the invite unconsumed.
 */
export async function redeemFreeTierInvite(db: PlatformDB, clerkUserId: string): Promise<RedeemInviteOutcome> {
  const redeemed = await db.executor.updateTable('free_tier_invites')
    .set({ consumed_at: sql<Date>`now()` })
    .where('clerk_user_id', '=', clerkUserId)
    .where('consumed_at', 'is', null)
    .returning('clerk_user_id')
    .executeTakeFirst();
  if (redeemed) return 'redeemed';
  return await getFreeTierInvite(db, clerkUserId) ? 'already_redeemed' : 'not_invited';
}

/**
 * Admitted free owners: each holds a stored free entitlement and at most one
 * free runtime. This is the quantity `maxRuntimes` caps. Counting owners
 * rather than VM rows keeps an admitted owner counted while their metal VM is
 * being created, retried after a failure, or replaced.
 */
export async function countFreeOwners(db: PlatformDB): Promise<number> {
  const row = await db.executor.selectFrom('billing_entitlements')
    .select(sql<string>`count(*)`.as('count'))
    .where('source', '=', 'free')
    .executeTakeFirstOrThrow();
  return Number(row.count);
}

export async function readFreeTierCapacity(db: PlatformDB, config: FreeTierConfig): Promise<FreeTierCapacity> {
  const running = await db.executor.selectFrom('user_machines')
    .innerJoin('billing_entitlements', 'billing_entitlements.clerk_user_id', 'user_machines.clerk_user_id')
    .select(sql<string>`count(*)`.as('running'))
    .where('billing_entitlements.source', '=', 'free')
    .where('user_machines.substrate', '=', 'metal')
    .where('user_machines.status', '=', 'running')
    .where('user_machines.deleted_at', 'is', null)
    .executeTakeFirstOrThrow();
  const invites = await db.executor.selectFrom('free_tier_invites')
    .select(sql<string>`count(*)`.as('pending'))
    .where('consumed_at', 'is', null)
    .executeTakeFirstOrThrow();
  return {
    runtimes: await countFreeOwners(db),
    maxRuntimes: config.maxRuntimes,
    running: Number(running.running),
    invitesPending: Number(invites.pending),
    inviteRequired: config.inviteRequired,
  };
}

function noStore(c: Context): void {
  c.header('Cache-Control', 'no-store');
}

/** Operator administration, authenticated with the platform operator credential. */
export function createFreeTierOperatorRoutes(options: {
  db: PlatformDB;
  operatorSecret: string;
  config: FreeTierConfig;
  logError?: (message: string, err: unknown) => void;
}): Hono {
  const logError = options.logError ?? ((message, err) => {
    console.error(message, err instanceof Error ? err.message : String(err));
  });
  const app = new Hono();

  app.use('*', async (c, next) => {
    noStore(c);
    if (options.operatorSecret.length < MIN_OPERATOR_SECRET_LENGTH) return c.json({ error: 'unavailable' }, 503);
    const authorization = c.req.header('authorization');
    const token = authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined;
    if (!timingSafeTokenEquals(token, options.operatorSecret)) return c.json({ error: 'unauthorized' }, 401);
    return next();
  });

  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse();
    logError('[free-tier] operator route failed', err);
    noStore(c);
    return c.json({ error: 'internal_error' }, 500);
  });

  app.post('/invites', bodyLimit({ maxSize: OPERATOR_BODY_LIMIT }), async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch (err: unknown) {
      if (!(err instanceof SyntaxError)) throw err;
      return c.json({ error: 'invalid_request' }, 400);
    }
    const parsed = AddInviteBodySchema.safeParse(body);
    if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);
    const outcome = await addFreeTierInvite(options.db, parsed.data);
    const invite = await getFreeTierInvite(options.db, parsed.data.clerkUserId);
    return c.json(
      { invite: { clerkUserId: parsed.data.clerkUserId, consumed: Boolean(invite?.consumedAt) } },
      outcome === 'created' ? 201 : 200,
    );
  });

  app.delete('/invites/:userId', bodyLimit({ maxSize: OPERATOR_BODY_LIMIT }), async (c) => {
    const userId = ClerkUserIdParamSchema.safeParse(c.req.param('userId'));
    if (!userId.success) return c.json({ error: 'invalid_request' }, 400);
    const outcome = await removeFreeTierInvite(options.db, userId.data);
    if (outcome === 'removed') return c.body(null, 204);
    return outcome === 'consumed' ? c.json({ error: 'invite_consumed' }, 409) : c.json({ error: 'not_found' }, 404);
  });

  app.get('/capacity', async (c) => {
    if (!EmptyQuerySchema.safeParse(c.req.query()).success) return c.json({ error: 'invalid_request' }, 400);
    return c.json(await readFreeTierCapacity(options.db, options.config), 200);
  });

  return app;
}

/** Mounts operator administration ahead of session routing so the operator credential reaches its own guard. */
export function registerFreeTierOperatorRoutes<E extends Env>(
  app: Hono<E>,
  options: { db: PlatformDB; platformSecret: string; config: FreeTierConfig | undefined },
): void {
  if (!options.config) return;
  app.route('/internal/free-tier', createFreeTierOperatorRoutes({
    db: options.db, operatorSecret: options.platformSecret, config: options.config,
  }));
}
