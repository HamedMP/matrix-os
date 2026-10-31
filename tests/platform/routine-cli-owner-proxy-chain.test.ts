import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { createApp } from "../../packages/platform/src/main.js";
import { createClerkAuth } from "../../packages/platform/src/clerk-auth.js";
import { insertUserMachine, insertContainer, type PlatformDB } from "../../packages/platform/src/db.js";
import { verifySyncJwt } from "../../packages/platform/src/sync-jwt.js";
import { verifyRoutineActionProof } from "../../packages/platform/src/routine-action-proof.js";
import { ROUTINE_ACTION_PROOF_HEADER } from "@matrix-os/contracts";
import { buildPlatformVerificationToken } from "../../packages/platform/src/platform-token.js";
import { createTestPlatformDb, destroyTestPlatformDb } from "./platform-db-test-helper.js";
import type { Orchestrator } from "../../packages/platform/src/orchestrator.js";
const JWT_SECRET = "synthetic-routine-sync-jwt-secret-at-least-32";
function stubOrchestrator(): Orchestrator {
  return { provision: vi.fn(), start: vi.fn(async () => {}), stop: vi.fn(), destroy: vi.fn(), upgrade: vi.fn(), rollingRestart: vi.fn(),
    getInfo: vi.fn(async handle => ({ handle, clerkUserId: "user_alice", containerId: "fixture-container", port: 5001, shellPort: 6001, status: "running", createdAt: "2026-10-31T00:00:00.000Z", lastActive: "2026-10-31T00:00:00.000Z" })),
    getImage: vi.fn(), listAll: vi.fn(async () => []), syncStates: vi.fn() };
}
const secret = "synthetic-platform-consent-domain-secret", handle = "alice-primary", ownerId = "user_alice", machineId = "machine-alice-primary";
const id = `rcact_${"a".repeat(32)}`, path = `/api/routine-cli/actions/${id}/decision`;
const body = { decision: "approve", clientRequestId: "de000000-0000-4000-8000-000000000001", actionDigest: "a".repeat(64) } as const;
const tuple = { ...body, handle, ownerId, runtimeSlot: "primary", machineId, challengeId: id } as const;
let db: PlatformDB, app: ReturnType<typeof createApp>, received: Headers | undefined;
beforeEach(async () => {
  vi.stubEnv("PLATFORM_JWT_SECRET", JWT_SECRET); vi.stubEnv("MATRIX_LEGACY_CONTAINER_ROUTING_ENABLED", "true");
  db = (await createTestPlatformDb()).db;
  await insertContainer(db, { handle: "alice", clerkUserId: ownerId, containerId: "fixture-container", port: 5001, shellPort: 6001, status: "running" });
  await insertUserMachine(db, { machineId, clerkUserId: ownerId, handle, runtimeSlot: "primary", status: "running", hetznerServerId: 100,
    publicIPv4: "203.0.113.20", imageVersion: "dev", serverType: "cpx22", provisionedAt: "2026-10-31T00:00:00.000Z" });
  app = createApp({ db, orchestrator: stubOrchestrator(), platformSecret: secret,
    clerkAuth: createClerkAuth({ verifyToken: async token => { if (token !== "clerk-fixture") throw new Error("Not Clerk"); return { sub: ownerId, sid: "sess_owner" }; } }) });
  received = undefined;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => { received = new Headers(init?.headers); return Response.json({ submission: "accepted" }); });
});
afterEach(async () => { await app.shutdownBrowserApprovals?.(); await app.shutdownPostHog(); vi.restoreAllMocks(); vi.unstubAllEnvs(); await destroyTestPlatformDb(db); });
async function submit(headers: Record<string, string>, explicit = true) {
  received = undefined;
  const response = await app.request((explicit ? `/vm/${handle}` : "") + path, { method: "POST", headers: { host: "app.matrix-os.com",
    "content-type": "application/json", [ROUTINE_ACTION_PROOF_HEADER]: "forged-caller-proof", ...headers }, body: JSON.stringify(body) });
  expect(response.status).toBe(200); return (received as Headers | undefined)?.get(ROUTINE_ACTION_PROOF_HEADER);
}
it("actual Clerk sid mints through both explicit VM and normal running VPS forwarding; signed browser exchange also works", async () => {
  for (const explicit of [true, false]) {
    const proof = await submit({ authorization: "Bearer clerk-fixture" }, explicit);
    expect(verifyRoutineActionProof(proof ?? undefined, tuple, secret)).toMatchObject(tuple);
    expect(proof).not.toBe("forged-caller-proof");
  }
  const exchanged = await app.request("/api/auth/app-session", { method: "POST", headers: { host: "app.matrix-os.com", authorization: "Bearer clerk-fixture", "content-type": "application/json" }, body: JSON.stringify({ redirectTo: "/" }) });
  expect(exchanged.status).toBe(200);
  const cookie = exchanged.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
  const proof = await submit({ cookie }); expect(verifyRoutineActionProof(proof ?? undefined, tuple, secret)).toMatchObject(tuple);
});
it.each(["matrixos-cli", "matrix-os-desktop"])("real %s device JWT and native cookie exchange cannot mint owner consent", async clientId => {
  const code = await (await app.request("/api/auth/device/code", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clientId }) })).json();
  const login = await app.request(`/auth/device?user_code=${code.userCode}`), csrf = /device_csrf=([^;]+)/.exec(login.headers.get("set-cookie") ?? "")?.[1];
  expect(csrf).toBeTruthy();
  expect((await app.request("/auth/device/approve", { method: "POST", headers: { authorization: "Bearer clerk-fixture", cookie: `device_csrf=${csrf}`, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ userCode: code.userCode, csrf: csrf! }).toString() })).status).toBe(200);
  const polled = await app.request("/api/auth/device/token", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ deviceCode: code.deviceCode, clientId }) });
  expect(polled.status).toBe(200); const token = (await polled.json()).accessToken;
  expect((await verifySyncJwt(token, { secret: JWT_SECRET })).session_provenance).toBe("clerk-device");
  expect(await submit({ authorization: `Bearer ${token}`, "x-matrix-native-client": "matrix-os-desktop" })).toBeNull();
  const exchanged = await app.request("/api/auth/app-session", { method: "POST", headers: { host: "app.matrix-os.com", authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ redirectTo: "/" }) });
  expect(exchanged.status).toBe(200); expect(exchanged.headers.get("set-cookie")).toContain(encodeURIComponent(token));
  const cookie = exchanged.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
  expect(cookie).toContain("matrix_native_app_session="); expect(await submit({ cookie })).toBeNull();
});
it("holder-known runtime transport key cannot forge purpose MAC; every exact tuple field and expiry is checked", async () => {
  const proof = await submit({ authorization: "Bearer clerk-fixture" }); expect(proof).toEqual(expect.any(String));
  const encoded = proof!.split(".")[0]!;
  const forged = `${encoded}.${createHmac("sha256", buildPlatformVerificationToken(handle, secret)).update(`matrix-routine-cli-owner-action:v1\0${encoded}`).digest("hex")}`;
  expect(verifyRoutineActionProof(forged, tuple, secret)).toBeNull();
  for (const patch of [{ ownerId: "user_foreign" }, { handle: "other-pc" }, { runtimeSlot: "other" }, { machineId: "replacement" },
    { challengeId: `rcact_${"b".repeat(32)}` }, { actionDigest: "b".repeat(64) }, { decision: "decline" }, { clientRequestId: "de000000-0000-4000-8000-000000000002" }])
    expect(verifyRoutineActionProof(proof ?? undefined, { ...tuple, ...patch } as typeof tuple, secret)).toBeNull();
  expect(verifyRoutineActionProof(proof ?? undefined, tuple, secret, Date.now() + 61_000)).toBeNull();
  expect(verifyRoutineActionProof(proof ?? undefined, tuple, "other-domain-key")).toBeNull();
});
it("the actual legacy container forwarding site strips caller proof and cannot invent a concrete Computer tuple", async () => {
  await db.executor.updateTable("user_machines").set({ deleted_at: new Date().toISOString() }).where("machine_id", "=", machineId).execute();
  const proof = await submit({ authorization: "Bearer clerk-fixture" }, false); expect(proof).toBeNull();
});
