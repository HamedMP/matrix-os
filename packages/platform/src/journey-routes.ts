import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod/v4';
import {
  getActiveUserMachineByClerkId,
  upsertOnboardingFirstRun,
  type PlatformDB,
} from './db.js';
import { loadJourney, type JourneyReadinessAnnotation } from './journey.js';
import { CustomerVpsError } from './customer-vps-errors.js';
import { verifySyncJwt } from './sync-jwt.js';

export interface JourneyClerkAuth {
  extractToken: (authorization?: string, cookie?: string) => string | null;
  verify: (token: string) => Promise<{ authenticated: boolean; userId?: string | null }>;
}

/**
 * Resolves the journey caller's clerkUserId from either a Clerk session
 * (cookie or bearer — web/mobile) or a platform sync JWT (bearer — CLI, native
 * macOS app). This is the single auth seam every surface shares; the native app
 * consumes it with its keychain sync JWT exactly as the CLI does.
 */
export function createJourneyUserResolver(opts: {
  clerkAuth?: JourneyClerkAuth;
  syncJwtSecret?: string;
}): (c: Context) => Promise<string | null> {
  return async (c: Context): Promise<string | null> => {
    const authorization = c.req.header('authorization');
    const cookie = c.req.header('cookie');
    // 1. Clerk session (cookie or Clerk bearer).
    if (opts.clerkAuth) {
      try {
        const token = opts.clerkAuth.extractToken(authorization, cookie);
        if (token) {
          const result = await opts.clerkAuth.verify(token);
          if (result.authenticated && result.userId) return result.userId;
        }
      } catch {
        // fall through to sync-JWT
      }
    }
    // 2. Platform sync JWT (CLI / native / mobile token paste).
    const bearer = authorization?.toLowerCase().startsWith('bearer ')
      ? authorization.slice(7).trim()
      : undefined;
    if (bearer && opts.syncJwtSecret) {
      try {
        const claims = await verifySyncJwt(bearer, { secret: opts.syncJwtSecret });
        if (claims.sub) return claims.sub;
      } catch {
        return null;
      }
    }
    return null;
  };
}

const SAFE_SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const INTERNAL_BODY_LIMIT = 16 * 1024;
const RETRY_BODY_LIMIT = 1024;

const RetryBodySchema = z.object({
  runtimeSlot: z.string().regex(SAFE_SLUG).optional(),
});

const FirstRunBodySchema = z.object({
  clerkUserId: z.string().min(1).max(256),
  handle: z.string().regex(SAFE_SLUG),
  completedAt: z.iso.datetime(),
  goal: z.enum(['coding', 'company_brain', 'assistant']).optional(),
  steps: z.record(z.string().max(64), z.unknown()).optional(),
  source: z.enum(['gateway_ws', 'shell_manual']),
});

export interface JourneyRetryResult {
  status: 'started' | 'in_progress';
}

export interface JourneyRoutesOptions {
  db: PlatformDB;
  /** Dual auth: Clerk session cookie / bearer, or platform sync JWT. Returns clerkUserId or null. */
  resolveUserId: (c: Context) => Promise<string | null>;
  /** Triggers a provisioning attempt (billing-checked). Absent when provisioning is unavailable. */
  provisionRuntime?: (clerkUserId: string, runtimeSlot: string) => Promise<void>;
  /** Expected internal token for gateway->platform first-run reports (UPGRADE_TOKEN). */
  internalToken?: string;
  appOrigin: string;
  maxProvisionAttempts: number;
  settlingWindowMs?: number;
  now?: () => Date;
  /** Optional readiness annotation provider for the ready phase (Phase C wires this). */
  resolveReadiness?: (clerkUserId: string) => Promise<JourneyReadinessAnnotation | undefined>;
}

function applyNoStore(c: Context): void {
  c.header('Cache-Control', 'no-store');
}

function tokensMatch(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

const LIVE_MACHINE_STATUSES = new Set(['provisioning', 'recovering', 'running']);

export function createJourneyRoutes(options: JourneyRoutesOptions): Hono {
  const app = new Hono();
  const now = options.now ?? (() => new Date());

  async function buildJourney(clerkUserId: string, runtimeSlot?: string) {
    const readiness = options.resolveReadiness ? await options.resolveReadiness(clerkUserId) : undefined;
    return loadJourney(clerkUserId, {
      db: options.db,
      now,
      settlingWindowMs: options.settlingWindowMs,
      maxProvisionAttempts: options.maxProvisionAttempts,
      appOrigin: options.appOrigin,
      runtimeSlot,
      readiness,
    });
  }

  app.get('/api/journey', async (c) => {
    applyNoStore(c);
    const clerkUserId = await options.resolveUserId(c);
    if (!clerkUserId) return c.json({ error: 'Unauthorized' }, 401);
    try {
      return c.json(await buildJourney(clerkUserId), 200);
    } catch (err: unknown) {
      console.error('[journey] state derivation failed:', err instanceof Error ? err.message : String(err));
      return c.json({ error: 'journey_unavailable' }, 503);
    }
  });

  app.post('/api/journey/retry-provision', bodyLimit({ maxSize: RETRY_BODY_LIMIT }), async (c) => {
    applyNoStore(c);
    const clerkUserId = await options.resolveUserId(c);
    if (!clerkUserId) return c.json({ error: 'Unauthorized' }, 401);

    // Body is optional; an empty body means "retry the primary slot".
    let body: unknown = {};
    const raw = await c.req.text();
    if (raw.trim().length > 0) {
      try {
        body = JSON.parse(raw);
      } catch {
        return c.json({ error: 'Invalid request' }, 400);
      }
    }
    const parsed = RetryBodySchema.safeParse(body);
    if (!parsed.success) return c.json({ error: 'Invalid request' }, 400);
    const runtimeSlot = parsed.data.runtimeSlot ?? 'primary';

    if (!options.provisionRuntime) {
      return c.json({ error: 'provisioning_unavailable' }, 503);
    }

    try {
      // Converge on an in-flight attempt rather than starting a duplicate (FR-028).
      const existing = await getActiveUserMachineByClerkId(options.db, clerkUserId, runtimeSlot);
      if (existing && LIVE_MACHINE_STATUSES.has(existing.status)) {
        return c.json({ status: 'in_progress', journey: await buildJourney(clerkUserId, runtimeSlot) }, 200);
      }
      await options.provisionRuntime(clerkUserId, runtimeSlot);
      return c.json({ status: 'started', journey: await buildJourney(clerkUserId, runtimeSlot) }, 200);
    } catch (err: unknown) {
      if (err instanceof CustomerVpsError) {
        if (err.code === 'billing_required') return c.json({ error: 'billing_required' }, 402);
        if (err.code === 'retry_exhausted') return c.json({ error: 'retry_exhausted' }, 409);
      }
      console.error('[journey] retry-provision failed:', err instanceof Error ? err.message : String(err));
      return c.json({ error: 'provisioning_unavailable' }, 503);
    }
  });

  app.post('/internal/first-run', bodyLimit({ maxSize: INTERNAL_BODY_LIMIT }), async (c) => {
    applyNoStore(c);
    const expected = options.internalToken;
    const header = c.req.header('authorization');
    const presented = header?.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : undefined;
    if (!expected || !presented || !tokensMatch(presented, expected)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch (err: unknown) {
      if (err instanceof SyntaxError) return c.json({ error: 'Invalid request' }, 422);
      throw err;
    }
    const parsed = FirstRunBodySchema.safeParse(body);
    if (!parsed.success) return c.json({ error: 'Invalid request' }, 422);

    // The header handle must match the body handle the gateway claims for.
    const headerHandle = c.req.header('x-matrix-handle');
    if (headerHandle && headerHandle !== parsed.data.handle) {
      return c.json({ error: 'Invalid request' }, 422);
    }

    try {
      await upsertOnboardingFirstRun(options.db, {
        clerkUserId: parsed.data.clerkUserId,
        completedAt: parsed.data.completedAt,
        goal: parsed.data.goal ?? null,
        steps: parsed.data.steps ?? {},
        source: parsed.data.source,
      });
      return c.body(null, 204);
    } catch (err: unknown) {
      console.error('[journey] first-run upsert failed:', err instanceof Error ? err.message : String(err));
      return c.json({ error: 'first_run_unavailable' }, 503);
    }
  });

  return app;
}
