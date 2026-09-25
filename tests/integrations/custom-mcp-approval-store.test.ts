import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KyselyPGlite } from "kysely-pglite";
import { createPlatformDb, type PlatformDb } from "../../packages/gateway/src/platform-db.js";

interface ApprovalStoreContract {
  registerCustomMcpRunLease(input: {
    userId: string; actorId: string; runId: string; expiresAt: Date;
  }): Promise<{ id: string } | null>;
  reserveCustomMcpToolApproval(input: {
    userId: string; actorId: string; runId: string; nativeRequestId: string;
    serverId: string; serverRevision: number; toolName: string; argsDigest: string;
    expiresAt: Date;
  }): Promise<{ approvalId: string; expiresAt: Date } | null>;
  decideCustomMcpToolApproval(input: {
    userId: string; actorId: string; runId: string; approvalId: string;
    decision: "approve" | "decline" | "cancel";
    validateDecisionProof?: () => boolean;
  }): Promise<{ receipt?: string } | null>;
  consumeCustomMcpToolApproval(input: {
    userId: string; actorId: string; runId: string; serverId: string;
    serverRevision: number; toolName: string; argsDigest: string;
    receipt: string;
  }): Promise<boolean>;
  revokeCustomMcpRunLease(input: {
    userId: string; actorId: string; runId: string;
  }): Promise<boolean>;
}

const at = new Date("2026-09-25T00:00:00.000Z");
const later = (ms: number) => new Date(at.getTime() + ms);
const digest = "a".repeat(64);

describe("Custom MCP durable one-use approval contract", () => {
  let db: PlatformDb & ApprovalStoreContract;
  let pglite: InstanceType<typeof KyselyPGlite>;
  let userId: string;
  let serverId: string;
  let clock = at;
  let clockHook: (() => Date) | undefined;

  beforeEach(async () => {
    pglite = await KyselyPGlite.create();
    clock = at;
    clockHook = undefined;
    db = createPlatformDb({ dialect: pglite.dialect, now: () => clockHook?.() ?? clock }) as PlatformDb & ApprovalStoreContract;
    await db.migrate();
    userId = (await db.createUser({
      clerkId: "clerk-owner", handle: "owner", displayName: "Owner", email: "owner@example.test",
      containerId: "container-owner",
    })).id;
    const server = await db.createCustomMcpServer({
      userId, name: "Fixture", url: "https://mcp.example.test/mcp", authMode: "none",
      pendingExpiresAt: later(60_000),
    });
    serverId = server.id;
    await db.updateCustomMcpServer(serverId, userId, server.revision, {
      status: "ready", enabled: true, tools: [{
        name: "publish", description: "Publish fixture", inputSchema: { type: "object" },
        enabled: true, approval: "always_ask",
      }],
    });
  });

  afterEach(async () => { await db.destroy(); });

  const lease = (db: ApprovalStoreContract, userId: string, actorId = "clerk-owner", runId = "run_owner") =>
    db.registerCustomMcpRunLease({ userId, actorId, runId, expiresAt: later(35 * 60_000) });

  function approvalInput(userId: string, serverId: string, override: Record<string, unknown> = {}) {
    return {
      userId, actorId: "clerk-owner", runId: "run_owner", nativeRequestId: "native_1",
      serverId, serverRevision: 2, toolName: "publish", argsDigest: digest,
      expiresAt: later(10 * 60_000),
      ...override,
    };
  }

  it("binds a real decision to actor, Run, server revision, tool, arguments, expiry and one consumption", async () => {
    expect(await lease(db, userId)).toMatchObject({ id: expect.any(String) });
    const pending = await db.reserveCustomMcpToolApproval(approvalInput(userId, serverId));
    expect(pending?.approvalId).toEqual(expect.any(String));
    const decided = await db.decideCustomMcpToolApproval({
      userId, actorId: "clerk-owner", runId: "run_owner",
      approvalId: pending!.approvalId, decision: "approve",
    });
    expect(decided?.receipt).toMatch(/^[a-f0-9]{64}$/);
    const call = (override: Record<string, unknown> = {}) => db.consumeCustomMcpToolApproval({
      userId, actorId: "clerk-owner", runId: "run_owner", serverId,
      serverRevision: 2, toolName: "publish", argsDigest: digest,
      receipt: decided!.receipt!, ...override,
    });
    for (const mismatch of [
      { actorId: "foreign-actor" }, { runId: "run_foreign" },
      { serverRevision: 3 }, { toolName: "other" }, { argsDigest: "b".repeat(64) },
    ]) expect(await call(mismatch)).toBe(false);
    clock = later(10 * 60_000);
    expect(await call()).toBe(false);
    clock = later(2_000);
    expect((await Promise.all([call(), call()])).filter(Boolean)).toHaveLength(1);
    expect(await call()).toBe(false);
  });

  it("rechecks the trusted clock and proof after policy locks before reserve, decision or consume", async () => {
    await lease(db, userId);
    let reads = 0;
    clockHook = () => ++reads === 1 ? at : later(10 * 60_000);
    expect(await db.reserveCustomMcpToolApproval(approvalInput(userId, serverId))).toBeNull();
    clockHook = undefined;

    const pending = await db.reserveCustomMcpToolApproval(approvalInput(userId, serverId));
    expect(pending).not.toBeNull();
    reads = 0;
    let proofValid = true;
    clockHook = () => { if (++reads >= 2) proofValid = false; return at; };
    expect(await db.decideCustomMcpToolApproval({ userId, actorId: "clerk-owner", runId: "run_owner",
      approvalId: pending!.approvalId, decision: "approve", validateDecisionProof: () => proofValid })).toBeNull();
    clockHook = undefined;
    const receipt = (await db.decideCustomMcpToolApproval({ userId, actorId: "clerk-owner",
      runId: "run_owner", approvalId: pending!.approvalId, decision: "approve" }))!.receipt!;
    reads = 0;
    clockHook = () => ++reads === 1 ? at : later(10 * 60_000);
    expect(await db.consumeCustomMcpToolApproval({ userId, actorId: "clerk-owner", runId: "run_owner",
      serverId, serverRevision: 2, toolName: "publish", argsDigest: digest, receipt })).toBe(false);
    clockHook = undefined;
  });

  it("denies unapproved, declined and revoked calls, including stale server policy", async () => {
    await lease(db, userId);
    const pending = await db.reserveCustomMcpToolApproval(approvalInput(userId, serverId));
    expect(pending).not.toBeNull();
    expect(await db.decideCustomMcpToolApproval({
      userId, actorId: "foreign-actor", runId: "run_owner", approvalId: pending!.approvalId,
      decision: "approve",
    })).toBeNull();
    expect(await db.decideCustomMcpToolApproval({
      userId, actorId: "clerk-owner", runId: "run_owner", approvalId: pending!.approvalId,
      decision: "decline",
    })).toEqual({});
    expect(await db.decideCustomMcpToolApproval({
      userId, actorId: "clerk-owner", runId: "run_owner", approvalId: pending!.approvalId,
      decision: "approve",
    })).toBeNull();

    const next = await db.reserveCustomMcpToolApproval(approvalInput(userId, serverId, { nativeRequestId: "native_2" }));
    const receipt = (await db.decideCustomMcpToolApproval({
      userId, actorId: "clerk-owner", runId: "run_owner", approvalId: next!.approvalId,
      decision: "approve",
    }))!.receipt!;
    await db.updateCustomMcpServer(serverId, userId, 2, { enabled: false });
    expect(await db.consumeCustomMcpToolApproval({
      userId, actorId: "clerk-owner", runId: "run_owner", serverId,
      serverRevision: 2, toolName: "publish", argsDigest: digest, receipt,
    })).toBe(false);
    expect(await db.reserveCustomMcpToolApproval(approvalInput(userId, serverId, { nativeRequestId: "native_3" }))).toBeNull();
  });

  it("revokes an approved receipt and does not reactivate the same lease", async () => {
    const registered = await lease(db, userId);
    const pending = await db.reserveCustomMcpToolApproval(approvalInput(userId, serverId));
    const receipt = (await db.decideCustomMcpToolApproval({
      userId, actorId: "clerk-owner", runId: "run_owner", approvalId: pending!.approvalId,
      decision: "approve",
    }))!.receipt!;
    expect(await db.revokeCustomMcpRunLease({
      userId, actorId: "clerk-owner", runId: "run_owner",
    })).toBe(true);
    expect(await lease(db, userId)).toBeNull();
    expect(registered?.id).toEqual(expect.any(String));
    expect(await db.consumeCustomMcpToolApproval({
      userId, actorId: "clerk-owner", runId: "run_owner", serverId,
      serverRevision: 2, toolName: "publish", argsDigest: digest, receipt,
    })).toBe(false);
  });

  it("lets a native cancel revoke an approved but unconsumed receipt before dispatch", async () => {
    await lease(db, userId);
    const pending = await db.reserveCustomMcpToolApproval(approvalInput(userId, serverId));
    const receipt = (await db.decideCustomMcpToolApproval({
      userId, actorId: "clerk-owner", runId: "run_owner", approvalId: pending!.approvalId,
      decision: "approve",
    }))!.receipt!;
    expect(await db.decideCustomMcpToolApproval({ userId, actorId: "clerk-owner",
      runId: "run_owner", approvalId: pending!.approvalId, decision: "cancel" })).toEqual({});
    expect(await db.consumeCustomMcpToolApproval({ userId, actorId: "clerk-owner", runId: "run_owner",
      serverId, serverRevision: 2, toolName: "publish", argsDigest: digest, receipt })).toBe(false);
    expect(await db.decideCustomMcpToolApproval({ userId, actorId: "clerk-owner",
      runId: "run_owner", approvalId: pending!.approvalId, decision: "approve" })).toBeNull();
  });

  it("settles a consume-versus-cancel race exactly once", async () => {
    await lease(db, userId);
    const pending = await db.reserveCustomMcpToolApproval(approvalInput(userId, serverId));
    const receipt = (await db.decideCustomMcpToolApproval({ userId, actorId: "clerk-owner",
      runId: "run_owner", approvalId: pending!.approvalId, decision: "approve" }))!.receipt!;
    const [cancelled, consumed] = await Promise.all([
      db.decideCustomMcpToolApproval({ userId, actorId: "clerk-owner", runId: "run_owner",
        approvalId: pending!.approvalId, decision: "cancel" }),
      db.consumeCustomMcpToolApproval({ userId, actorId: "clerk-owner", runId: "run_owner",
        serverId, serverRevision: 2, toolName: "publish", argsDigest: digest, receipt }),
    ]);
    expect(Number(cancelled !== null) + Number(consumed)).toBe(1);
    expect(await db.consumeCustomMcpToolApproval({ userId, actorId: "clerk-owner", runId: "run_owner",
      serverId, serverRevision: 2, toolName: "publish", argsDigest: digest, receipt })).toBe(false);
  });

  it("rechecks policy at decision and uses the current trusted clock after admission", async () => {
    await lease(db, userId);
    const pending = await db.reserveCustomMcpToolApproval(approvalInput(userId, serverId));
    expect(pending).not.toBeNull();
    await db.updateCustomMcpServer(serverId, userId, 2, { enabled: false });
    expect(await db.decideCustomMcpToolApproval({
      userId, actorId: "clerk-owner", runId: "run_owner",
      approvalId: pending!.approvalId, decision: "approve",
    })).toBeNull();
    await db.updateCustomMcpServer(serverId, userId, 3, { enabled: true });
    clock = later(10 * 60_000);
    expect(await db.decideCustomMcpToolApproval({
      userId, actorId: "clerk-owner", runId: "run_owner",
      approvalId: pending!.approvalId, decision: "approve",
    })).toBeNull();
  });

  it("counts approved unconsumed receipts toward the per-Run cap", async () => {
    await lease(db, userId);
    for (let index = 0; index < 16; index++) {
      const pending = await db.reserveCustomMcpToolApproval(approvalInput(userId, serverId, {
        nativeRequestId: `native_${index}`,
      }));
      expect(pending).not.toBeNull();
      expect((await db.decideCustomMcpToolApproval({
        userId, actorId: "clerk-owner", runId: "run_owner",
        approvalId: pending!.approvalId, decision: "approve",
      }))?.receipt).toMatch(/^[a-f0-9]{64}$/);
    }
    expect(await db.reserveCustomMcpToolApproval(approvalInput(userId, serverId, {
      nativeRequestId: "native_over_cap",
    }))).toBeNull();
  });

  it("prunes expired epochs in bounded maintenance without reviving an old receipt", async () => {
    const first = await lease(db, userId);
    const pending = await db.reserveCustomMcpToolApproval(approvalInput(userId, serverId));
    const receipt = (await db.decideCustomMcpToolApproval({
      userId, actorId: "clerk-owner", runId: "run_owner",
      approvalId: pending!.approvalId, decision: "approve",
    }))!.receipt!;
    await db.revokeCustomMcpRunLease({ userId, actorId: "clerk-owner", runId: "run_owner" });
    clock = later(24 * 60 * 60_000 + 36 * 60_000);
    expect(await db.sweepCustomMcpApprovals(clock)).toBeGreaterThan(0);
    expect(await db.sweepCustomMcpApprovals(clock)).toBeGreaterThanOrEqual(0);
    const second = await db.registerCustomMcpRunLease({
      userId, actorId: "clerk-owner", runId: "run_owner", expiresAt: later(26 * 60 * 60_000),
    });
    expect(second?.id).not.toBe(first?.id);
    expect(await db.consumeCustomMcpToolApproval({
      userId, actorId: "clerk-owner", runId: "run_owner", serverId,
      serverRevision: 2, toolName: "publish", argsDigest: digest, receipt,
    })).toBe(false);
  });

  it("enforces the owner cap across distinct Run IDs", async () => {
    await pglite.client.query(`
      INSERT INTO custom_mcp_run_leases
        (id, user_id, actor_id, run_id, status, expires_at, created_at, updated_at)
      SELECT gen_random_uuid(), $1, 'clerk-owner', 'run_seed_' || n, 'active', $2, $3, $3
      FROM generate_series(1, 127) AS n
    `, [userId, later(35 * 60_000), at]);
    expect(await db.registerCustomMcpRunLease({
      userId, actorId: "clerk-owner", runId: "run_128_a", expiresAt: later(35 * 60_000),
    })).not.toBeNull();
    expect(await db.registerCustomMcpRunLease({
      userId, actorId: "clerk-owner", runId: "run_128_b", expiresAt: later(35 * 60_000),
    })).toBeNull();
  });
});
