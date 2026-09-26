import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { JEV_MODEL_ID } from "@matrix-os/contracts";
import { createFundedModelProbeService } from "../../packages/platform/src/ai-funded-model-probes.js";
import { createAiFundedPolicyRepository } from "../../packages/platform/src/ai-funded-policy-repository.js";
import { insertUserMachine, type PlatformDB } from "../../packages/platform/src/db.js";
import { createTestPlatformDb, destroyTestPlatformDb } from "./platform-db-test-helper.js";
let db: PlatformDB;
beforeEach(async () => { ({ db } = await createTestPlatformDb()); });
afterEach(async () => { await destroyTestPlatformDb(db); });
async function fixture() {
  const repository = createAiFundedPolicyRepository({ db, credentialHashSecret: "h".repeat(32) });
  await repository.updateGlobalPolicy({ expectedRevision: 0, enabled: true, allowedModelIds: [JEV_MODEL_ID] });
  const runtime = (suffix: string) => ({ identity: { ownerId: `owner_${suffix}`, machineId: `machine_${suffix}`, runtimeSlot: "primary" }, globalRevision: 1, runtimeRevision: 1 });
  for (const suffix of ["a", "b"]) {
    const { identity } = runtime(suffix);
    await insertUserMachine(db, { ...identity, clerkUserId: identity.ownerId, handle: `fixture-${suffix}`,
      status: "running", imageVersion: "fixture", provisionedAt: new Date().toISOString(), activationState: "authorized" });
    await repository.setRuntimePolicy({ identity, expectedRevision: 0, enabled: true, allowedModelIds: [JEV_MODEL_ID], monthlyBudgetMicrousd: 1_000_000, expiresAt: null });
  }
  const issue = vi.spyOn(repository, "issueJevProbeCredential");
  const revoke = vi.spyOn(repository, "revokeRuntimeCredential");
  const fetchFn = vi.fn<typeof fetch>(async (raw, init) => {
    expect(new URL(String(raw)).pathname).toBe("/v1/jev-readiness");
    expect(init).toMatchObject({ method: "POST", body: "{}", redirect: "error", signal: expect.any(AbortSignal) });
    return Response.json({ ready: true, priceValidThrough: "2026-09-30T23:59:59.999Z" });
  });
  const service = createFundedModelProbeService({ db, credentials: repository, relayBaseUrl: "https://relay.example.test",
    relayControlToken: "c".repeat(32), dailyLimit: 10, minuteLimit: 2, fetchFn });
  return { service, repository, runtime, issue, revoke, fetchFn };
}
it("coalesces exact owner observations, isolates another owner, and revokes only temporary tokens", async () => {
  const f = await fixture();
  const results = await Promise.all(Array.from({ length: 12 }, () => f.service.probe(JEV_MODEL_ID, { runtime: f.runtime("a") })));
  expect(results.every(result => result.ready)).toBe(true);
  expect((await f.service.probe(JEV_MODEL_ID, { runtime: f.runtime("b") })).ready).toBe(true);
  expect(f.fetchFn).toHaveBeenCalledTimes(2); expect(f.issue).toHaveBeenCalledTimes(2); expect(f.revoke).toHaveBeenCalledTimes(2);
  const rows = await db.executor.selectFrom("ai_runtime_credentials").select(["owner_id", "revoked_at"]).execute();
  expect(rows).toHaveLength(2); expect(rows.every(row => row.revoked_at !== null)).toBe(true);
});
it("a settled readiness probe leaves the first ordinary credential available within thirty seconds", async () => {
  const f = await fixture();
  expect((await f.service.probe(JEV_MODEL_ID, { runtime: f.runtime("a") })).ready).toBe(true);
  const ordinary = await f.repository.issueRuntimeCredential(f.runtime("a").identity);
  expect(ordinary.identity).toEqual(f.runtime("a").identity);
  await expect(f.repository.issueRuntimeCredential(f.runtime("a").identity)).rejects.toMatchObject({ code: "rate_limited" });
  const row = await db.executor.selectFrom("ai_runtime_credentials").select("revoked_at")
    .where("token_id", "=", ordinary.credential.tokenId).executeTakeFirstOrThrow();
  expect(row.revoked_at).toBeNull();
});
it("never probes Jev without explicit exact runtime identity and revisions", async () => {
  const f = await fixture();
  expect((await f.service.probe(JEV_MODEL_ID)).ready).toBe(false);
  expect((await f.service.probe(JEV_MODEL_ID, { runtime: { ...f.runtime("a"), runtimeRevision: 2 } })).ready).toBe(false);
  expect(f.fetchFn).not.toHaveBeenCalled();
  expect(f.revoke).toHaveBeenCalledOnce();
});
it("does not populate ready cache after cancellation and revokes the delayed temporary credential", async () => {
  const f = await fixture(); const response = Promise.withResolvers<Response>();
  f.fetchFn.mockImplementationOnce(async () => response.promise);
  const controller = new AbortController();
  const pending = f.service.probe(JEV_MODEL_ID, { runtime: f.runtime("a"), signal: controller.signal });
  await vi.waitFor(() => expect(f.fetchFn).toHaveBeenCalledOnce()); controller.abort();
  expect((await pending).ready).toBe(false);
  response.resolve(Response.json({ ready: true, priceValidThrough: "2026-09-30T23:59:59.999Z" }));
  await vi.waitFor(() => expect(f.revoke).toHaveBeenCalledOnce());
  await vi.waitFor(async () => {
    const rows = await db.executor.selectFrom("ai_runtime_credentials").select("revoked_at").execute();
    expect(rows.every(row => row.revoked_at !== null)).toBe(true);
  });
  // A changed revision never reuses the cancelled observation.
  expect((await f.service.probe(JEV_MODEL_ID, { runtime: { ...f.runtime("a"), globalRevision: 2 } })).ready).toBe(false);
});
it("does not revoke or rotate an ordinary credential when a separate capped probe completes", async () => {
  const f = await fixture(); const identity = f.runtime("a").identity;
  const ordinary = await f.repository.issueRuntimeCredential(identity);
  expect((await f.service.probe(JEV_MODEL_ID, { runtime: f.runtime("a") })).ready).toBe(true);
  const row = await db.executor.selectFrom("ai_runtime_credentials").select("revoked_at").where("token_id", "=", ordinary.credential.tokenId).executeTakeFirstOrThrow();
  expect(row.revoked_at).toBeNull(); expect(f.fetchFn).toHaveBeenCalledOnce(); expect(f.revoke).toHaveBeenCalledOnce();
});
it("revokes the temporary token when a relay body stalls past caller cancellation", async () => {
  const f = await fixture(); const cancelled = vi.fn();
  f.fetchFn.mockResolvedValueOnce(new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{"ready":')); }, cancel: cancelled })));
  const controller = new AbortController();
  const pending = f.service.probe(JEV_MODEL_ID, { runtime: f.runtime("a"), signal: controller.signal });
  await vi.waitFor(() => expect(f.fetchFn).toHaveBeenCalledOnce()); controller.abort();
  expect((await pending).ready).toBe(false);
  await vi.waitFor(() => expect(f.revoke).toHaveBeenCalledOnce());
  expect(cancelled).toHaveBeenCalledOnce();
});
