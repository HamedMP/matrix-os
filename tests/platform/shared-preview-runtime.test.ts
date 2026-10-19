import { Hono } from "hono";
import { registerSharedPreviewRuntime, resolveFundedRuntimeMachine } from "../../packages/platform/src/shared-preview-runtime.js";
import { createAiFundedRuntimeRoutes, createAiFundedOperatorRoutes } from "../../packages/platform/src/ai-funded-policy-routes.js";
import { createAiFundedPolicyRepository } from "../../packages/platform/src/ai-funded-policy-repository.js";
import { buildPlatformRuntimeVerificationToken } from "../../packages/platform/src/platform-token.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getActiveUserMachineByClerkId, getAccessibleActiveUserMachineByClerkId,
  getRunningUserMachineByClerkId, getRunningUserMachineByHandle,
  insertUserMachine, type NewUserMachine, type PlatformDB,
} from "../../packages/platform/src/db.js";
import { listUserRuntimeComputersByClerkId } from "../../packages/platform/src/computer-repository.js";
import { createTestPlatformDb, destroyTestPlatformDb } from "./native-platform-db-test-helper.js";

const shared = (owner = "user_alice"): NewUserMachine => ({
  machineId: `shared_${owner}`, clerkUserId: owner, handle: "swp-2758-aabbccdd",
  runtimeSlot: "swp-2758-aabbccdd", sourcePr: 2758,
  provisioningClass: "shared-preview" as NewUserMachine["provisioningClass"],
  status: "running", activationState: "authorized", provisionedAt: "2026-10-19T11:30:00.000Z",
});

describe("shared preview runtime authority", () => {
  let db: PlatformDB;
  beforeEach(async () => { ({ db } = await createTestPlatformDb()); });
  afterEach(async () => { await destroyTestPlatformDb(db); });

  it("keeps an owner-only logical Worker out of personal/native computer selection", async () => {
    await insertUserMachine(db, shared());
    expect(await listUserRuntimeComputersByClerkId(db, "user_alice", 20)).toEqual([]);
    expect(await resolveFundedRuntimeMachine(db, "swp-2758-aabbccdd", "swp-2758-aabbccdd")).toBeUndefined();
    expect(await getActiveUserMachineByClerkId(db, "user_alice")).toBeUndefined();
    expect(await getAccessibleActiveUserMachineByClerkId(db, "user_alice")).toBeUndefined();
    expect(await getRunningUserMachineByClerkId(db, "user_alice")).toBeUndefined();
    expect(await getRunningUserMachineByHandle(db, "swp-2758-aabbccdd", "swp-2758-aabbccdd")).toBeUndefined();
  });

  it("preserves an existing VPS as the default after shared runtime registration", async () => {
    await insertUserMachine(db, { machineId: "personal", clerkUserId: "user_alice", handle: "alice", runtimeSlot: "primary",
      status: "running", provisionedAt: "2026-10-01T00:00:00.000Z" });
    const before = await listUserRuntimeComputersByClerkId(db, "user_alice", 20);
    await insertUserMachine(db, shared());
    expect(await listUserRuntimeComputersByClerkId(db, "user_alice", 20)).toEqual(before);
    expect((await getActiveUserMachineByClerkId(db, "user_alice"))?.machineId).toBe("personal");
    expect((await getAccessibleActiveUserMachineByClerkId(db, "user_alice"))?.machineId).toBe("personal");
  });
  it("registers one durable identity per owner/PR without repointing or sharing a Worker", async () => {
    const input = { ownerId: "user_alice", sourcePr: 2758, workerOrigin: "https://alice.example.workers.dev" };
    const first = await registerSharedPreviewRuntime(db, input);
    const again = await registerSharedPreviewRuntime(db, input);
    expect(again.machineId).toBe(first.machineId);
    expect(first.clerkUserId).toBe("user_alice");
    expect(first.provisioningClass).toBe("shared-preview");
    await expect(registerSharedPreviewRuntime(db, { ...input, workerOrigin: "https://changed.example.workers.dev" })).rejects.toThrow();
    await expect(registerSharedPreviewRuntime(db, { ...input, ownerId: "user_bob" })).rejects.toThrow();
    const rows = await db.executor.selectFrom("user_machines").selectAll().where("provisioning_class", "=", "shared-preview").execute();
    expect(rows).toHaveLength(1); // failed binding insert rolled back its metadata row
  });

  it("allows existing funded issuance for a registered shared identity and rejects another runtime's token", async () => {
    const machine = await registerSharedPreviewRuntime(db, { ownerId: "user_alice", sourcePr: 2758, workerOrigin: "https://alice.example.workers.dev" });
    const repository = createAiFundedPolicyRepository({ db, credentialHashSecret: "h".repeat(40) });
    const model = "anthropic/claude-sonnet-5";
    await repository.updateGlobalPolicy({ expectedRevision: 0, enabled: true, allowedModelIds: [model] });
    await repository.setRuntimePolicy({ identity: { ownerId: machine.clerkUserId, machineId: machine.machineId, runtimeSlot: machine.runtimeSlot },
      expectedRevision: 0, enabled: true, allowedModelIds: [model], monthlyBudgetMicrousd: 1_000_000,
      expiresAt: new Date(Date.now() + 3600_000).toISOString() });
    const platformSecret = "p".repeat(40);
    const app = new Hono().route("/:handle", createAiFundedRuntimeRoutes({ db, platformSecret, repository }));
    const token = buildPlatformRuntimeVerificationToken(machine, platformSecret, machine.runtimeTokenEpoch);
    const path = `/${machine.handle}/funded-credential?runtimeSlot=${machine.runtimeSlot}`;
    const request = (authorization: string) => app.request(path, { method: "POST", headers: { authorization: `Bearer ${authorization}`, "content-type": "application/json" }, body: JSON.stringify({ requestClass: "background" }) });
    expect((await request(buildPlatformRuntimeVerificationToken({ ...machine, machineId: "wrong_machine" }, platformSecret))).status).toBe(401);
    const response = await request(token);
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.identity).toMatchObject({ ownerId: "user_alice", machineId: machine.machineId, runtimeSlot: machine.runtimeSlot });
    expect(result.requestClass).toBe("background");
  });

  it.each(["read", "revoke", "grant", "release"])("allows authenticated operators to %s a registered Starter runtime", async operation => {
    const machine = await registerSharedPreviewRuntime(db, { ownerId: "user_alice", sourcePr: 2758, workerOrigin: "https://alice.example.workers.dev" });
    const repository = createAiFundedPolicyRepository({ db, credentialHashSecret: "h".repeat(40) });
    const identity = { ownerId: machine.clerkUserId, machineId: machine.machineId, runtimeSlot: machine.runtimeSlot };
    const model = "anthropic/claude-sonnet-5";
    await repository.updateGlobalPolicy({ expectedRevision: 0, enabled: true, allowedModelIds: [model] });
    await repository.setRuntimePolicy({ identity, expectedRevision: 0, enabled: true,
      allowedModelIds: [model], monthlyBudgetMicrousd: 1_000_000, expiresAt: null });
    const release = vi.spyOn(repository, "releaseExecutionAdmission").mockResolvedValue({ contractVersion: 1,
      executionAdmissionReleased: true, usageKnown: false, reservedMicrousd: 100, maximumLiabilityMicrousd: 100,
      releasedAt: new Date().toISOString() });
    const secret = "o".repeat(40);
    const app = createAiFundedOperatorRoutes({ db, repository, operatorSecret: secret,
      promotionalGrant: { enabled: true, campaignId: "starter-test", amountMicrousd: 1000,
        expiresAt: new Date(Date.now() + 3600_000).toISOString() } });
    const headers = { authorization: `Bearer ${secret}`, "content-type": "application/json" };
    let path = "policy"; let method = "GET"; let body;
    if (operation === "revoke") { method = "PUT"; body = { expectedRevision: 1, enabled: false,
      allowedModelIds: [model], monthlyBudgetMicrousd: 1_000_000, expiresAt: null }; }
    if (operation === "grant") { path = "promotional-grant"; method = "POST"; body = {}; }
    if (operation === "release") { path = "policy-execution-release"; method = "POST"; body = {
      expectedOwnerId: machine.clerkUserId, reservationId: "reservation_test", tokenId: "token_test", expectedRequestId: "request_test",
      expectedStartedAt: "2026-10-01T00:00:00.000Z", expectedExpiresAt: "2026-10-01T00:10:00.000Z", maximumLiabilityMicrousd: 100,
      localRunId: "run_test", localRunState: "completed", localRunEndedAt: "2026-10-01T00:10:00.000Z",
      evidenceRef: "test:termination", reviewer: "test:operator", acceptUnknownUpstreamLiability: true }; }
    const url = `/runtimes/${machine.handle}/${path}`;
    expect((await app.request(url, { method, headers: { ...headers, authorization: "Bearer wrong" }, body: body === undefined ? undefined : JSON.stringify(body) })).status).toBe(401);
    const response = await app.request(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    expect(response.status).toBe(200);
    if (operation === "release") expect(release).toHaveBeenCalledWith(identity, body);
    if (operation === "revoke") expect((await repository.getRuntimePolicy(identity)).enabled).toBe(false);
  });

  it("serializes repeated registrations and never revives a retired authority", async () => {
    const input = { ownerId: "user_alice", sourcePr: 2758, workerOrigin: "https://alice.example.workers.dev" };
    const records = await Promise.all([registerSharedPreviewRuntime(db, input), registerSharedPreviewRuntime(db, input)]);
    expect(records[0].machineId).toBe(records[1].machineId);
    await db.executor.updateTable("user_machines").set({ status: "stopped" }).where("machine_id", "=", records[0].machineId).execute();
    await expect(registerSharedPreviewRuntime(db, input)).rejects.toThrow();
    expect(await resolveFundedRuntimeMachine(db, records[0].handle, records[0].runtimeSlot)).toBeUndefined();
  });

  it("erases a retired runtime's binding without deleting another owner's authority", async () => {
    const alice = await registerSharedPreviewRuntime(db, { ownerId: "user_alice", sourcePr: 2758, workerOrigin: "https://alice.example.workers.dev" });
    const bob = await registerSharedPreviewRuntime(db, { ownerId: "user_bob", sourcePr: 2758, workerOrigin: "https://bob.example.workers.dev" });
    // Operator fixture: physical cleanup precedes the account's metadata erasure.
    await db.executor.updateTable("user_machines").set({ status: "deleted", deleted_at: new Date().toISOString() }).where("machine_id", "=", alice.machineId).execute();
    await db.executor.deleteFrom("user_machines").where("machine_id", "=", alice.machineId).execute();
    const remaining = await db.executor.selectFrom("shared_preview_runtime_bindings").selectAll().execute();
    expect(remaining.map(row => row.machine_id)).toEqual([bob.machineId]);
  });

  it.each(["http://localhost", "https://alice.example.workers.dev/path", "https://user:secret@example.com", "https://example.com?token=secret"])("rejects an invalid Worker origin before database writes: %s", async workerOrigin => {
    await expect(registerSharedPreviewRuntime(db, { ownerId: "user_alice", sourcePr: 2758, workerOrigin })).rejects.toThrow();
    expect(await db.executor.selectFrom("user_machines").selectAll().execute()).toHaveLength(0);
  });

});
