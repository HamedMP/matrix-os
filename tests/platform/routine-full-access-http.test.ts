import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApp } from "../../packages/platform/src/main.js";
import { createClerkAuth } from "../../packages/platform/src/clerk-auth.js";
import { insertContainer, insertUserMachine, type PlatformDB } from "../../packages/platform/src/db.js";
import { BrowserApprovalMachineLookup } from "../../packages/platform/src/browser-approval-machine-lookup.js";
import { buildPlatformVerificationToken } from "../../packages/platform/src/platform-token.js";
import { ROUTINE_FULL_ACCESS_PROOF_HEADER, ROUTINE_FULL_ACCESS_SCOPE_HEADER, RoutineFullAccessTupleSchema } from "@matrix-os/contracts";
import { issueSyncJwt } from "../../packages/platform/src/sync-jwt.js";
import { createHash } from "node:crypto";
import { createTestPlatformDb, destroyTestPlatformDb } from "./platform-db-test-helper.js";
import type { Orchestrator } from "../../packages/platform/src/orchestrator.js";

const secret = "synthetic-full-origin-platform-secret", handle = "owner-pc", ownerId = "user_owner", machineId = "machine_owner";
const challengeId = `rcfull_${"a".repeat(32)}`, path = `/api/chats/chat_owner/routine-cli/full-access/challenges/${challengeId}/decision`;
const body = { scopeDigest: "b".repeat(64), decision: "approve", clientRequestId: "de000000-0000-4000-8000-000000000001" } as const;
const tuple = { kind: "scope_decision", handle, ownerId, runtimeSlot: "primary", machineId, chatId: "chat_owner", challengeId, ...body } as const;
let db: PlatformDB, app: ReturnType<typeof createApp>, lookup: BrowserApprovalMachineLookup, received: Headers | undefined;
const lookupEnd = vi.fn(async () => {});
beforeEach(async () => {
  vi.stubEnv("PLATFORM_JWT_SECRET", "synthetic-sync-session-key-at-least-32-chars");
  vi.stubEnv("MATRIX_SUPERVISED_BROWSER_APPROVALS_ENABLED", "false");
  vi.stubEnv("MATRIX_API_ORIGIN", "https://api.matrix-os.com");
  const initialized = await createTestPlatformDb(); db = initialized.db; lookupEnd.mockClear();
  lookup = new BrowserApprovalMachineLookup({ databaseUrl: "postgresql://synthetic.invalid/platform", poolFactory: (() => ({
    connect: async () => ({ query: (sql: string, values?: unknown[]) => initialized.instance.client.query(sql, values), release() {} }), on() {}, end: lookupEnd,
  })) as never });
  await insertContainer(db, { handle: "owner", clerkUserId: ownerId, containerId: "fixture", port: 5001, shellPort: 6001, status: "running" });
  await insertUserMachine(db, { machineId, clerkUserId: ownerId, handle, runtimeSlot: "primary", status: "running", hetznerServerId: 100,
    publicIPv4: "203.0.113.20", imageVersion: "dev", serverType: "cpx22", provisionedAt: "2026-10-31T00:00:00.000Z" });
  const orchestrator = { provision: vi.fn(), start: vi.fn(), stop: vi.fn(), destroy: vi.fn(), upgrade: vi.fn(), rollingRestart: vi.fn(),
    getInfo: vi.fn(), getImage: vi.fn(), listAll: vi.fn(async () => []), syncStates: vi.fn() } as unknown as Orchestrator;
  app = createApp({ db, orchestrator, platformSecret: secret, browserApprovalMachineLookup: lookup,
    clerkAuth: createClerkAuth({ verifyToken: async token => {
      if (token !== "synthetic-clerk") throw new Error("Not Clerk");
      return { sub: ownerId, sid: "session_owner", exp: Math.floor(Date.now() / 1000) + 120 };
    } }) });
  received = undefined;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => { received = new Headers(init?.headers); return Response.json({ accepted: true }); });
});
afterEach(async () => {
  const closedBeforeShutdown = lookupEnd.mock.calls.length;
  await app.shutdownBrowserApprovals?.(); expect(lookupEnd).toHaveBeenCalledTimes(closedBeforeShutdown);
  await lookup.close(); expect(lookupEnd).toHaveBeenCalledOnce();
  await app.shutdownPostHog(); vi.restoreAllMocks(); vi.unstubAllEnvs(); await destroyTestPlatformDb(db);
});
async function ownerProof(explicit = true) {
  const response = await app.request(`${explicit ? `/vm/${handle}` : ""}${path}`, { method: "POST", headers: { host: "app.matrix-os.com", authorization: "Bearer synthetic-clerk",
    "content-type": "application/json", [ROUTINE_FULL_ACCESS_PROOF_HEADER]: "untrusted-caller-proof" }, body: JSON.stringify(body) });
  expect(response.status).toBe(200);
  const proof = received?.get(ROUTINE_FULL_ACCESS_PROOF_HEADER); expect(proof).toEqual(expect.any(String));
  expect(proof).not.toBe("untrusted-caller-proof"); return proof!;
}
function verify(proof: string, data: unknown = tuple, headers: Record<string, string> = {}, raw?: string) {
  return app.request(`/internal/containers/${handle}/routine-full-access/verify`, { method: "POST", headers: {
    authorization: `Bearer ${buildPlatformVerificationToken(handle, secret)}`, "content-type": "application/json", [ROUTINE_FULL_ACCESS_PROOF_HEADER]: proof, ...headers,
  }, body: raw ?? JSON.stringify(data) });
}

it("registers the Full Access verifier in the actual app and binds a genuine browser proxy proof to current SQL owner/machine/slot", async () => {
  for (const explicit of [true, false]) {
    const response = await verify(await ownerProof(explicit));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ verified: { ...tuple, purpose: "routine_cli_full_access_origin" } });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  }
});

it("strips incoming Full Access proof when ordinary device/legacy browser authentication cannot mint", async () => {
  for (const sessionProvenance of [undefined, "clerk-device", "clerk-browser"] as const) {
    const token = await issueSyncJwt({ clerkUserId: ownerId, handle, runtimeSlot: "primary", gatewayUrl: `https://${handle}.matrix-os.com`,
      ...(sessionProvenance ? { sessionProvenance } : {}), secret: "synthetic-sync-session-key-at-least-32-chars" });
    for (const explicit of [true, false]) {
      received = undefined;
      const response = await app.request(`${explicit ? `/vm/${handle}` : ""}${path}`, { method: "POST", headers: { host: "app.matrix-os.com",
        authorization: `Bearer ${token.token}`, "content-type": "application/json", [ROUTINE_FULL_ACCESS_PROOF_HEADER]: "forged-caller-proof" }, body: JSON.stringify(body) });
      expect(response.status).toBe(200); expect((received as Headers | undefined)?.get(ROUTINE_FULL_ACCESS_PROOF_HEADER)).toBeNull();
    }
  }
});

it("strips caller proof on an unrelated proxy path even with a valid browser and scope selector", async () => {
  const response = await app.request(`/vm/${handle}/api/unrelated-route`, { method: "POST", headers: { host: "app.matrix-os.com",
    authorization: "Bearer synthetic-clerk", "content-type": "application/json", [ROUTINE_FULL_ACCESS_SCOPE_HEADER]: challengeId,
    [ROUTINE_FULL_ACCESS_PROOF_HEADER]: "forged-caller-proof" }, body: JSON.stringify({ permissionMode: "full_access" }) });
  expect(response.status).toBe(200); expect(received?.get(ROUTINE_FULL_ACCESS_PROOF_HEADER)).toBeNull();
});

it("attests ordinary turn browser origin plus its scope selector and verifies it without manufacturing a consent ledger", async () => {
  const request = { clientRequestId: "req_owner_turn", baseRevision: 0, parts: [{ type: "text", text: "Inspect the routine" }],
    selection: { instanceId: "claude_code_default", model: "claude-sonnet-4-5" }, interactionMode: "default", permissionMode: "full_access" };
  const response = await app.request(`/vm/${handle}/api/chats/chat_owner/turns`, { method: "POST", headers: { host: "app.matrix-os.com",
    authorization: "Bearer synthetic-clerk", "content-type": "application/json", [ROUTINE_FULL_ACCESS_SCOPE_HEADER]: challengeId,
    [ROUTINE_FULL_ACCESS_PROOF_HEADER]: "forged-caller-proof" }, body: JSON.stringify(request) });
  expect(response.status).toBe(200);
  const proof = received?.get(ROUTINE_FULL_ACCESS_PROOF_HEADER); expect(proof).toEqual(expect.any(String));
  const turnTuple = RoutineFullAccessTupleSchema.parse({ kind: "turn", handle, runtimeSlot: "primary", ownerId, machineId,
    chatId: "chat_owner", scopeId: challengeId, clientRequestId: request.clientRequestId, requestDigest: createHash("sha256").update(JSON.stringify(request)).digest("hex") });
  expect((await verify(proof!, turnTuple)).status).toBe(200);
  expect((await verify(proof!, { ...turnTuple, clientRequestId: "req_different_turn" })).status).toBe(403);
});

it("rejects missing/invalid transport, missing/forged proof and every wrong tuple binding", async () => {
  const proof = await ownerProof();
  for (const authorization of ["", "Bearer unrelated", `Bearer ${secret}`]) expect((await verify(proof, tuple, { authorization })).status).toBe(401);
  for (const value of ["", "forged-caller-proof", proof + "corrupt"]) expect((await verify(value)).status).toBe(403);
  for (const patch of [{ ownerId: "user_foreign" }, { machineId: "replacement" }, { runtimeSlot: "other" }, { chatId: "chat_other" },
    { challengeId: `rcfull_${"d".repeat(32)}` }, { scopeDigest: "0".repeat(64) }, { decision: "decline" },
    { clientRequestId: "de000000-0000-4000-8000-000000000002" }]) expect((await verify(proof, { ...tuple, ...patch })).status).toBe(403);
  expect((await verify(proof, { ...tuple, handle: "foreign-pc" })).status).toBe(400);
});

it("strictly bounds malformed and actual oversized input even when Content-Length lies", async () => {
  const proof = await ownerProof();
  expect((await verify(proof, tuple, {}, "{")).status).toBe(400);
  expect((await verify(proof, { ...tuple, permissionMode: "full_access" })).status).toBe(400);
  for (const headers of [{}, { "content-length": "1" }]) expect((await verify(proof, tuple, headers, " ".repeat(4001))).status).toBe(413);
  const query = await app.request(`/internal/containers/${handle}/routine-full-access/verify?ownerId=foreign`, { method: "POST", headers: {
    authorization: `Bearer ${buildPlatformVerificationToken(handle, secret)}` }, body: JSON.stringify(tuple) });
  expect(query.status).toBe(400);
});

it.each(["owner", "machine", "slot", "stopped", "deleted"])("checks the actual current SQL %s registry binding before returning verified origin", async changed => {
  const proof = await ownerProof();
  const update = changed === "owner" ? { clerk_user_id: "user_foreign" } : changed === "machine" ? { machine_id: "replacement" }
    : changed === "slot" ? { runtime_slot: "other" } : changed === "stopped" ? { status: "stopped" } : { deleted_at: new Date().toISOString() };
  await db.executor.updateTable("user_machines").set(update).where("handle", "=", handle).execute();
  expect((await verify(proof)).status).toBe(403);
});

it("fails closed for unavailable/closed lookup and releases eight-request admission after lookups settle", async () => {
  const proof = await ownerProof();
  const unavailable = vi.spyOn(lookup, "resolveMachine").mockRejectedValueOnce(new Error("private-network-path-secret"));
  const failed = await verify(proof); expect(failed.status).toBe(503); expect(await failed.text()).not.toContain("private-network");
  unavailable.mockRestore();
  type Machine = Awaited<ReturnType<typeof lookup.resolveMachine>>;
  const releases: Array<(value: Machine) => void> = [];
  const blocked = vi.spyOn(lookup, "resolveMachine").mockImplementation(() => new Promise(resolve => releases.push(resolve)));
  const pending = Array.from({ length: 8 }, () => verify(proof));
  await vi.waitFor(() => expect(releases).toHaveLength(8));
  expect((await verify(proof)).status).toBe(503);
  for (const release of releases) release({ machineId, clerkUserId: ownerId, runtimeSlot: "primary", status: "running" });
  expect((await Promise.all(pending)).map(value => value.status)).toEqual(Array(8).fill(200));
  blocked.mockRestore(); expect((await verify(proof)).status).toBe(200);
  await lookup.close(); expect((await verify(proof)).status).toBe(503);
});

it("times out a slow registered verifier stream before bodyLimit waits forever and releases its admission", async () => {
  const proof = await ownerProof(); let cancelled = false;
  const request = new Request(`http://localhost/internal/containers/${handle}/routine-full-access/verify`, { method: "POST", headers: {
    authorization: `Bearer ${buildPlatformVerificationToken(handle, secret)}`, [ROUTINE_FULL_ACCESS_PROOF_HEADER]: proof },
    body: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("{")); }, cancel() { cancelled = true; } }), duplex: "half" } as RequestInit);
  const response = await app.request(request);
  expect(response.status).toBe(408); expect(cancelled).toBe(true);
  expect((await verify(proof)).status).toBe(200);
}, 10_000);

it("does not return verified origin when the signed proof expires during its current-machine lookup", async () => {
  const proof = await ownerProof(), payload = JSON.parse(Buffer.from(proof.split(".")[0]!, "base64url").toString("utf8"));
  vi.spyOn(lookup, "resolveMachine").mockImplementationOnce(async () => {
    vi.spyOn(Date, "now").mockReturnValue(payload.expiresAt);
    return { machineId, clerkUserId: ownerId, runtimeSlot: "primary", status: "running" };
  });
  expect((await verify(proof)).status).toBe(403);
});
