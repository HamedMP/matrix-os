/**
 * S00 / T003 — Clerk organization authority boundary probes for spec 124.
 *
 * Runs under `bun run test:integration`. Live Clerk probes need a test
 * organization and a secret key; without them they report UNRUN with the
 * missing fixture named. Local probes (JWT clock skew and evidence-deadline
 * arithmetic) always run. Never store tokens.
 */
import { randomUUID } from "node:crypto";
import { SignJWT, jwtVerify, generateKeyPair, errors as joseErrors } from "jose";
import { afterAll, describe, expect, it } from "vitest";

const CLERK_API = "https://api.clerk.com/v1";
const PROBE_TIMEOUT_MS = 60_000;
const MAX_SKEW_ALLOWANCE_SECONDS = 5;
const ORG_EVIDENCE_DEADLINE_SECONDS = 20;
const REMOVAL_BOUND_SECONDS = 60;

const fixtures = {
  secretKey: process.env.COLLABORATION_PROBE_CLERK_SECRET_KEY,
  orgId: process.env.COLLABORATION_PROBE_CLERK_ORG_ID,
  memberUserId: process.env.COLLABORATION_PROBE_CLERK_MEMBER_USER_ID,
  rejoinUserId: process.env.COLLABORATION_PROBE_CLERK_REJOIN_USER_ID,
  webhookInboxUrl: process.env.COLLABORATION_PROBE_CLERK_WEBHOOK_INBOX_URL,
} as const;

const unrun = (fixture: string): string => `unrun: fixture ${fixture} missing`;

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}

/**
 * Clerk responses are parsed explicitly: a non-JSON body is a probe failure, never
 * silently read as empty data. Only `SyntaxError` is expected from a bad body.
 */
async function parseJsonBody<T>(response: Response, context: string): Promise<T> {
  const text = await response.text();
  try {
    return JSON.parse(text) as T;
  } catch (error: unknown) {
    if (!(error instanceof SyntaxError)) throw error;
    console.warn("[s00-probe] non-JSON response", { context, status: response.status, length: text.length });
    throw new Error(`${context}: expected JSON body, got HTTP ${response.status} with ${text.length} bytes`);
  }
}

async function clerk<T>(method: string, path: string, body?: unknown): Promise<{ status: number; json: T }> {
  const response = await fetch(`${CLERK_API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${fixtures.secretKey}`,
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  return { status: response.status, json: await parseJsonBody<T>(response, `${method} ${path}`) };
}

interface Membership {
  id: string;
  role: string;
  public_user_data?: { user_id?: string };
}

async function listMemberships(): Promise<Membership[]> {
  const result = await clerk<{ data: Membership[] }>("GET", `/organizations/${fixtures.orgId}/memberships?limit=100`);
  expect(result.status).toBe(200);
  return result.json.data;
}

async function roleOf(userId: string): Promise<string | null> {
  const memberships = await listMemberships();
  return memberships.find((m) => m.public_user_data?.user_id === userId)?.role ?? null;
}

describe("S00 authority probes: local clock-skew and deadline rules (always run)", () => {
  it("rejects a JWT expired beyond the skew allowance and accepts one inside it", async () => {
    const { privateKey, publicKey } = await generateKeyPair("ES256");
    const now = Math.floor(Date.now() / 1000);
    const expiredWellBeyond = await new SignJWT({ org_id: "org_probe" }).setProtectedHeader({ alg: "ES256" })
      .setIssuedAt(now - 60).setExpirationTime(now - 30).sign(privateKey);
    await expect(jwtVerify(expiredWellBeyond, publicKey, { clockTolerance: MAX_SKEW_ALLOWANCE_SECONDS }))
      .rejects.toBeInstanceOf(joseErrors.JWTExpired);
    const expiredInsideSkew = await new SignJWT({ org_id: "org_probe" }).setProtectedHeader({ alg: "ES256" })
      .setIssuedAt(now - 60).setExpirationTime(now - 2).sign(privateKey);
    const verified = await jwtVerify(expiredInsideSkew, publicKey, { clockTolerance: MAX_SKEW_ALLOWANCE_SECONDS });
    expect(verified.payload.org_id).toBe("org_probe");
  });

  it("anchors the organization evidence deadline to the upstream request start, not receipt", () => {
    // Model of the rule in data-model.md "Lease and revocation protocol": the 20-second
    // evidence deadline counts from the moment the authoritative request started; slow
    // upstreams and clock tolerance shorten the usable window and never extend it.
    const requestStartMs = 1_000_000;
    const upstreamLatencyMs = 7_000;
    const receiptMs = requestStartMs + upstreamLatencyMs;
    const deadlineMs = requestStartMs + ORG_EVIDENCE_DEADLINE_SECONDS * 1_000;
    const usableMs = deadlineMs - receiptMs;
    expect(usableMs).toBe(13_000);
    expect(deadlineMs).toBeLessThan(receiptMs + ORG_EVIDENCE_DEADLINE_SECONDS * 1_000);
    expect(MAX_SKEW_ALLOWANCE_SECONDS).toBeLessThanOrEqual(5);
    expect(REMOVAL_BOUND_SECONDS).toBe(60);
  });
});

describe("S00 authority probes: live Clerk organization membership", () => {
  const membershipPath = (userId: string) => `/organizations/${fixtures.orgId}/memberships/${userId}`;
  const RESTORE_ATTEMPTS = 5;

  /**
   * Fixture-safety protocol: the desired end state is recorded in `pendingRestores`
   * BEFORE any mutation, restoration retries with backoff and verifies by reading back,
   * and `afterAll` replays anything still pending (a test timeout can abandon a `finally`).
   * A restore that still fails after retries throws loudly with the manual repair.
   */
  const pendingRestores = new Map<string, { role: string }>();
  /**
   * Bound and eviction policy for `pendingRestores`: at most MAX_PENDING_RESTORES entries.
   * Eviction is drain-on-full: when the map is full, every pending entry is restored
   * (verified, with retries) and removed before a new mutation is admitted. An entry is
   * never dropped unrestored, because that would abandon a shared fixture; if a drain
   * cannot restore an entry the new mutation is refused (fail closed) and `afterAll`
   * retries the remainder. The live harness touches at most two users.
   */
  const MAX_PENDING_RESTORES = 4;

  async function drainPendingRestores(): Promise<void> {
    for (const userId of [...pendingRestores.keys()]) await restoreOrThrow(userId);
  }

  async function restoreMembership(userId: string, role: string): Promise<boolean> {
    for (let attempt = 1; attempt <= RESTORE_ATTEMPTS; attempt += 1) {
      try {
        const current = await roleOf(userId);
        if (current === role) return true;
        if (current === null) await clerk("POST", `/organizations/${fixtures.orgId}/memberships`, { user_id: userId, role });
        else await clerk("PATCH", membershipPath(userId), { role });
        if ((await roleOf(userId)) === role) return true;
      } catch (error: unknown) {
        console.warn("[s00-probe] clerk restore attempt failed", { attempt, name: errorName(error) });
      }
      await new Promise((r) => setTimeout(r, attempt * 1_000));
    }
    return false;
  }

  async function restoreOrThrow(userId: string): Promise<void> {
    const pending = pendingRestores.get(userId);
    if (!pending) return;
    if (await restoreMembership(userId, pending.role)) {
      pendingRestores.delete(userId);
      return;
    }
    throw new Error(`fixture restore failed for ${userId}: manually set role ${pending.role} in organization ${fixtures.orgId}`);
  }

  afterAll(drainPendingRestores);

  /** Registers the restore target before `body` runs any mutation; restore is verified. */
  async function withMembershipRestored(userId: string, body: (originalRole: string) => Promise<void>): Promise<void> {
    if (!pendingRestores.has(userId) && pendingRestores.size >= MAX_PENDING_RESTORES) {
      await drainPendingRestores();
      if (pendingRestores.size >= MAX_PENDING_RESTORES) {
        throw new Error(`refusing to mutate ${userId}: ${pendingRestores.size} fixture restores could not be drained`);
      }
    }
    const original = await roleOf(userId);
    expect(original).not.toBeNull();
    pendingRestores.set(userId, { role: original as string });
    try {
      await body(original as string);
    } finally {
      await restoreOrThrow(userId);
    }
  }

  it.skipIf(!fixtures.secretKey || !fixtures.orgId || !fixtures.memberUserId)(
    `direct role change is visible through the API within the removal bound (${unrun("COLLABORATION_PROBE_CLERK_SECRET_KEY/ORG_ID/MEMBER_USER_ID")})`,
    async () => {
      const memberUserId = fixtures.memberUserId as string;
      await withMembershipRestored(memberUserId, async (original) => {
        const target = original === "org:member" ? "org:admin" : "org:member";
        const started = Date.now();
        const update = await clerk("PATCH", membershipPath(memberUserId), { role: target });
        expect(update.status).toBe(200);
        let observed: string | null = null;
        while (Date.now() - started < REMOVAL_BOUND_SECONDS * 1_000) {
          observed = await roleOf(memberUserId);
          if (observed === target) break;
          await new Promise((r) => setTimeout(r, 1_000));
        }
        const elapsedMs = Date.now() - started;
        console.info("[s00-probe] clerk role change read-after-write", { elapsedMs });
        expect(observed).toBe(target);
        expect(elapsedMs).toBeLessThan(REMOVAL_BOUND_SECONDS * 1_000);
      });
    },
    PROBE_TIMEOUT_MS * 2,
  );

  it.skipIf(!fixtures.secretKey || !fixtures.orgId || !fixtures.memberUserId)(
    `concurrent role updates converge to one API-consistent value (${unrun("COLLABORATION_PROBE_CLERK_SECRET_KEY/ORG_ID/MEMBER_USER_ID")})`,
    async () => {
      const memberUserId = fixtures.memberUserId as string;
      await withMembershipRestored(memberUserId, async () => {
        const results = await Promise.all([
          clerk("PATCH", membershipPath(memberUserId), { role: "org:admin" }),
          clerk("PATCH", membershipPath(memberUserId), { role: "org:member" }),
        ]);
        expect(results.every((r) => r.status === 200 || r.status === 422)).toBe(true);
        const first = await roleOf(memberUserId);
        const second = await roleOf(memberUserId);
        expect(["org:admin", "org:member"]).toContain(first);
        expect(second).toBe(first);
      });
    },
    PROBE_TIMEOUT_MS,
  );

  it.skipIf(!fixtures.secretKey || !fixtures.orgId || !fixtures.rejoinUserId)(
    `remove then rejoin yields a new membership identity, never a revived one (${unrun("COLLABORATION_PROBE_CLERK_REJOIN_USER_ID")})`,
    async () => {
      const rejoinUserId = fixtures.rejoinUserId as string;
      const before = (await listMemberships()).find((m) => m.public_user_data?.user_id === rejoinUserId);
      expect(before).toBeTruthy();
      // Re-admission is registered before the DELETE and verified with retries, so a failed
      // assertion, API error or timeout between removal and rejoin cannot leave the fixture
      // user outside the organization.
      await withMembershipRestored(rejoinUserId, async (originalRole) => {
        const removed = await clerk("DELETE", membershipPath(rejoinUserId));
        expect(removed.status).toBe(200);
        expect(await roleOf(rejoinUserId)).toBeNull();
        const rejoined = await clerk<Membership>("POST", `/organizations/${fixtures.orgId}/memberships`, { user_id: rejoinUserId, role: originalRole });
        expect(rejoined.status).toBe(200);
        expect(rejoined.json.id).not.toBe(before?.id);
      });
    },
    PROBE_TIMEOUT_MS,
  );

  it.skipIf(!fixtures.webhookInboxUrl)(
    `webhook delivery order and duplicate events are observed at a public inbox (${unrun("COLLABORATION_PROBE_CLERK_WEBHOOK_INBOX_URL")})`,
    async () => {
      // Requires a publicly reachable inbox registered in the Clerk dashboard; the probe
      // only reads what arrived and records ordering/duplication for S03's inbox design.
      const response = await fetch(`${fixtures.webhookInboxUrl}?probe=${randomUUID()}`, { signal: AbortSignal.timeout(10_000) });
      expect(response.status).toBeLessThan(500);
      const events = await parseJsonBody<Array<{ type?: string; svix_id?: string }>>(response, "webhook inbox");
      const ids = events.map((e) => e.svix_id).filter(Boolean);
      console.info("[s00-probe] clerk webhook inbox", { count: events.length, duplicates: ids.length - new Set(ids).size });
      expect(Array.isArray(events)).toBe(true);
    },
    PROBE_TIMEOUT_MS,
  );
  it.skipIf(!fixtures.secretKey || !fixtures.orgId || !fixtures.memberUserId)(
    `S03 projection observes a live removal within the ${REMOVAL_BOUND_SECONDS}s bound and never renews evidence past its deadline (${unrun("COLLABORATION_PROBE_CLERK_SECRET_KEY/ORG_ID/MEMBER_USER_ID")})`,
    async () => {
      const { createTestPlatformDb, destroyTestPlatformDb } = await import("../platform/platform-db-test-helper.js");
      const { bootstrapPlatformOrganizationDatabase } = await import("../../packages/platform/src/organizations/database.js");
      const { PlatformOrganizationRepository } = await import("../../packages/platform/src/organizations/repository.js");
      const { createOrganizationMembershipProjection } = await import("../../packages/platform/src/organizations/projection.js");
      const { ClerkOrganizationUpstreamClient } = await import("../../packages/platform/src/organizations/clerk-resolver.js");
      const memberUserId = fixtures.memberUserId!;
      const fixture = await createTestPlatformDb();
      try {
        const db = fixture.db.kysely as unknown as import("kysely").Kysely<import("../../packages/platform/src/organizations/database.js").OrganizationPlatformDatabase>;
        await bootstrapPlatformOrganizationDatabase(db);
        const repository = new PlatformOrganizationRepository(db);
        const projection = createOrganizationMembershipProjection({
          repository,
          upstream: new ClerkOrganizationUpstreamClient({ secretKey: fixtures.secretKey! }),
        });
        try {
          await projection.reconcile(fixtures.orgId!);
          const before = await projection.assert({ organizationId: fixtures.orgId!, actorId: memberUserId, requestStartedAt: new Date() });
          expect(before.member).toBe(true);
          expect(before.expiresAt.getTime() - before.requestStartedAt.getTime()).toBe(ORG_EVIDENCE_DEADLINE_SECONDS * 1_000);
          await withMembershipRestored(memberUserId, async () => {
            const removed = await clerk("DELETE", membershipPath(memberUserId));
            expect(removed.status).toBe(200);
            const startedAt = Date.now();
            let observedNegative = false;
            while (Date.now() - startedAt < REMOVAL_BOUND_SECONDS * 1_000) {
              const result = await projection.reconcile(fixtures.orgId!);
              const assertion = await projection.assert({ organizationId: fixtures.orgId!, actorId: memberUserId, requestStartedAt: new Date() });
              if (result.verified && !assertion.member) {
                observedNegative = true;
                break;
              }
              await new Promise((resolve) => setTimeout(resolve, 2_000));
            }
            const elapsedMs = Date.now() - startedAt;
            console.log("[s00-probe] S03 projection removal observed", { observedNegative, elapsedMs });
            expect(observedNegative).toBe(true);
            expect(elapsedMs).toBeLessThan(REMOVAL_BOUND_SECONDS * 1_000);
          });
        } finally {
          await projection.shutdown();
        }
      } finally {
        await destroyTestPlatformDb(fixture.db);
      }
    },
    PROBE_TIMEOUT_MS * 3,
  );
});
