import { createHash } from "node:crypto";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type IsolatedChatEnvelope, JEV_MODEL_ID } from "@matrix-os/contracts";
import { createAiFundedRuntimeRoutes } from "../../packages/platform/src/ai-funded-policy-routes.js";
import { createAiFundedPolicyRepository } from "../../packages/platform/src/ai-funded-policy-repository.js";
import { buildPlatformRuntimeVerificationToken } from "../../packages/platform/src/platform-token.js";
import { insertUserMachine, type PlatformDB } from "../../packages/platform/src/db.js";
import { createTestPlatformDb, destroyTestPlatformDb } from "./platform-db-test-helper.js";

/** Focused readiness composition regressions, using the existing owner/policy fixture path. */
describe("exact runtime cache-only funded readiness", () => {
  const model = "anthropic/claude-sonnet-5", secret = "platform-secret-for-tests-123456789";
  const identity = { ownerId: "user_alice", machineId: "machine_cache", runtimeSlot: "pv-2438-eaef1eaf" };
  const runtime = { handle: "alice", machineId: identity.machineId, runtimeSlot: identity.runtimeSlot };
  const token = buildPlatformRuntimeVerificationToken(runtime, secret);
  const at = "2026-10-10T12:00:00.000Z";
  const envelope: IsolatedChatEnvelope = { ...identity, phaseId: "phase_cache", chatId: "chat_cache", modelId: model,
    runtimeTokenEpoch: 1, runtimeCredentialSha256: createHash("sha256").update(token).digest("hex"),
    sourceSha: "a".repeat(40), startsAt: at, expiresAt: "2026-10-10T12:20:00.000Z" };
  let db: PlatformDB;
  beforeEach(async () => {
    ({ db } = await createTestPlatformDb());
    await insertUserMachine(db, { machineId: identity.machineId, clerkUserId: identity.ownerId, handle: runtime.handle,
      runtimeSlot: identity.runtimeSlot, status: "running", imageVersion: "v1", provisionedAt: at, activationState: "authorized" });
  });
  afterEach(async () => { await destroyTestPlatformDb(db); vi.restoreAllMocks(); });
  async function fixture(config: IsolatedChatEnvelope | null = envelope) {
    let clock = new Date(at);
    const repository = createAiFundedPolicyRepository({ db, credentialHashSecret: "h".repeat(43), now: () => clock });
    await repository.updateGlobalPolicy({ expectedRevision: 0, enabled: true, allowedModelIds: [model, JEV_MODEL_ID] });
    await repository.setRuntimePolicy({ identity, expectedRevision: 0, enabled: true, allowedModelIds: [model, JEV_MODEL_ID], expiresAt: null, monthlyBudgetMicrousd: 1000 });
    await repository.grantCredit({ entryId: "grant_cache", identity, kind: "promotional_grant", amountMicrousd: 1000, sourceReference: "cache-fixture" });
    const observation = { ready: true, checkedAt: "2026-10-10T11:59:00.000Z", staleAfter: "2026-10-10T12:04:00.000Z", priceValidThrough: "2026-10-10T12:04:00.000Z" };
    const readCached = vi.fn(async () => observation), probe = vi.fn(async () => observation);
    const app = new Hono().route("/internal/containers/:handle/ai", createAiFundedRuntimeRoutes({ db, repository,
      platformSecret: secret, isolatedChat: config ?? undefined, routeProbes: { readCached, probe }, now: () => clock }));
    const request = (body = "{}", auth = token, phaseHint?: string) => app.request(`/internal/containers/alice/ai/route-readiness?runtimeSlot=${identity.runtimeSlot}`, {
      method: "POST", headers: { authorization: `Bearer ${auth}`, "content-type": "application/json", ...(phaseHint === undefined ? {} : { "x-matrix-isolated-chat-phase": phaseHint }) }, body });
    return { repository, readCached, probe, request, observation, setClock: (value: Date) => { clock = value; } };
  }
  it("records server-only receipt branch and ready models without exposing diagnostic fields", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const f = await fixture();
    const good = await f.request();
    const body = await good.json() as Record<string, unknown>;
    expect(body.readyModelIds).toEqual([model]); expect(body.receiptId).toBeUndefined();
    const read = info.mock.calls.map(c => JSON.parse(String(c[0]))).find(e => e.event === "funded_readiness_route_receipt");
    expect(read).toMatchObject({ readyModelIds: [model], outcome: "ready", mode: "cache_only" });
    expect(read.receiptId).toMatch(/^[a-f0-9-]{36}$/);
    expect(JSON.stringify(read)).not.toContain(token); expect(JSON.stringify(read)).not.toContain(identity.ownerId);
    info.mockClear();
    expect((await f.request("{}", token, "wrong_phase")).status).toBe(503);
    expect(info.mock.calls.map(c => JSON.parse(String(c[0])))).toContainEqual(expect.objectContaining({
      event: "funded_readiness_route_receipt", stage: "phase_binding", outcome: "error",
    }));
    expect(f.probe).not.toHaveBeenCalled();
  });
  it.each(["absent", "phase", "identity"])("rejects a private phase binding when Platform configuration is %s", async kind => {
    const f = await fixture(kind === "absent" ? null : { ...envelope, ...(kind === "phase" ? { phaseId: "other_phase" } : { ownerId: "other_owner" }) });
    expect((await f.request("{}", token, envelope.phaseId)).status).toBe(503);
    expect(f.probe).not.toHaveBeenCalled(); expect(f.readCached).not.toHaveBeenCalled();
  });
  it("normal catalog and route reads use only cached health, retaining observation and owner funds", async () => {
    const f = await fixture();
    const before = await f.repository.getCheckoutFundingSummary(identity, Date.now() + 6000);
    expect((await f.request(JSON.stringify({ modelId: model }))).status).toBe(400);
    expect((await f.request(JSON.stringify({ cacheOnly: true }))).status).toBe(400);
    for (const body of ["{}", "{}"]) {
      const reply = await f.request(body); expect(reply.status).toBe(200);
      expect(await reply.json()).toMatchObject({ readyModelIds: [model], staleAfter: "2026-10-10T12:00:30.000Z" });
    }
    expect(f.readCached).toHaveBeenCalledTimes(2); expect(f.probe).not.toHaveBeenCalled();
    expect(await f.repository.getCheckoutFundingSummary(identity, Date.now() + 6000)).toEqual(before);
  });
  it.each(["miss", "stale", "database"])("fails closed for %s without fallback probing", async kind => {
    const f = await fixture();
    if (kind === "database") f.readCached.mockRejectedValue(new Error("fixture DB failure"));
    else f.readCached.mockResolvedValue({ ...f.observation, ready: kind !== "miss", staleAfter: kind === "stale" ? at : f.observation.staleAfter });
    const reply = await f.request(); expect(reply.status).toBe(kind === "database" ? 503 : 200);
    if (reply.status === 200) expect(await reply.json()).toMatchObject({ readyModelIds: [] });
    expect(f.probe).not.toHaveBeenCalled();
  });
  it.each(["epoch", "credential", "expiry"])("refuses %s mismatches before touching readiness", async kind => {
    const config = { ...envelope, ...(kind === "epoch" ? { runtimeTokenEpoch: 2 } : kind === "credential" ? { runtimeCredentialSha256: "c".repeat(64) } : {}) };
    const f = await fixture(config);
    if (kind === "expiry") f.setClock(new Date(config.expiresAt));
    expect((await f.request()).status).toBe(503); expect(f.probe).not.toHaveBeenCalled(); expect(f.readCached).not.toHaveBeenCalled();
  });
  it("rechecks policy after cached observation and rejects revoked owner funds", async () => {
    const f = await fixture();
    f.readCached.mockImplementation(async () => {
      await f.repository.updateGlobalPolicy({ expectedRevision: 1, enabled: false, allowedModelIds: [model, JEV_MODEL_ID] });
      return f.observation;
    });
    expect(await (await f.request()).json()).toMatchObject({ readyModelIds: [] });
    expect(f.probe).not.toHaveBeenCalled();
  });
  it("does not let clients suppress readiness; nontarget and Jev retain normal probes", async () => {
    const f = await fixture({ ...envelope, ownerId: "other_owner" });
    expect((await f.request(JSON.stringify({ cacheOnly: true }))).status).toBe(400);
    expect((await f.request()).status).toBe(200); expect(f.probe).toHaveBeenCalledTimes(1); expect(f.readCached).not.toHaveBeenCalled();
    const jev = await f.request(JSON.stringify({ modelId: JEV_MODEL_ID })); expect(jev.status).toBe(200);
    expect(f.probe).toHaveBeenLastCalledWith(JEV_MODEL_ID, expect.anything());
  });
});
