import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { createApp } from "../../packages/platform/src/main.js";
import { createClerkAuth } from "../../packages/platform/src/clerk-auth.js";
import { insertUserMachine, insertContainer, type PlatformDB } from "../../packages/platform/src/db.js";
import { issueSyncJwt, verifySyncJwt } from "../../packages/platform/src/sync-jwt.js";
import { verifyRoutineActionProof } from "../../packages/platform/src/routine-action-proof.js";
import { ROUTINE_ACTION_PROOF_HEADER } from "@matrix-os/contracts";
import { buildPlatformVerificationToken } from "../../packages/platform/src/platform-token.js";
import { BrowserApprovalMachineLookup } from "../../packages/platform/src/browser-approval-machine-lookup.js";
import * as sessionIdentity from "../../packages/platform/src/session-routing-identity.js";
import * as clerkSessions from "../../packages/platform/src/clerk-auth.js";
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
const deficientClerkTokens = ["clerk-no-sid", "clerk-empty-sid", "clerk-whitespace-sid", "clerk-no-exp", "clerk-invalid-exp",
  "clerk-zero-exp", "clerk-negative-exp", "clerk-fractional-exp", "clerk-expired"];
let db: PlatformDB, app: ReturnType<typeof createApp>, received: Headers | undefined, lookup: BrowserApprovalMachineLookup;
const lookupEnd = vi.fn(async () => {});
beforeEach(async () => {
  vi.stubEnv("PLATFORM_JWT_SECRET", JWT_SECRET); vi.stubEnv("MATRIX_LEGACY_CONTAINER_ROUTING_ENABLED", "true");
  vi.stubEnv("MATRIX_SUPERVISED_BROWSER_APPROVALS_ENABLED", "false");
  vi.stubEnv("MATRIX_API_ORIGIN", "https://api.matrix-os.com");
  vi.stubEnv("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", "pk_test_Y2xlcmsuZXhhbXBsZS5jb20k");
  const initialized = await createTestPlatformDb(); db = initialized.db;
  lookupEnd.mockClear();
  // Exercise the real bounded machine lookup against this fixture's actual SQL rows.
  // The injected pool wrapper does not own or close the shared fixture database.
  lookup = new BrowserApprovalMachineLookup({ databaseUrl: "postgresql://synthetic.invalid/platform", poolFactory: (() => ({
    connect: async () => ({ query: (sql: string, values?: unknown[]) => initialized.instance.client.query(sql, values), release() {} }),
    on() {}, end: lookupEnd,
  })) as never });
  await insertContainer(db, { handle: "alice", clerkUserId: ownerId, containerId: "fixture-container", port: 5001, shellPort: 6001, status: "running" });
  await insertUserMachine(db, { machineId, clerkUserId: ownerId, handle, runtimeSlot: "primary", status: "running", hetznerServerId: 100,
    publicIPv4: "203.0.113.20", imageVersion: "dev", serverType: "cpx22", provisionedAt: "2026-10-31T00:00:00.000Z" });
  app = createApp({ db, orchestrator: stubOrchestrator(), platformSecret: secret, browserApprovalMachineLookup: lookup,
    clerkAuth: createClerkAuth({ verifyToken: async token => {
      if (token === "clerk-no-sid") return { sub: ownerId, exp: Math.floor(Date.now() / 1000) + 120 };
      if (token === "clerk-no-exp") return { sub: ownerId, sid: "sess_owner" };
      if (token === "clerk-empty-sid") return { sub: ownerId, sid: "", exp: Math.floor(Date.now() / 1000) + 120 };
      if (token === "clerk-whitespace-sid") return { sub: ownerId, sid: "   ", exp: Math.floor(Date.now() / 1000) + 120 };
      if (token === "clerk-invalid-exp") return { sub: ownerId, sid: "sess_owner", exp: "not-an-epoch" };
      if (token === "clerk-zero-exp") return { sub: ownerId, sid: "sess_owner", exp: 0 };
      if (token === "clerk-negative-exp") return { sub: ownerId, sid: "sess_owner", exp: -1 };
      if (token === "clerk-fractional-exp") return { sub: ownerId, sid: "sess_owner", exp: Math.floor(Date.now() / 1000) + 120.5 };
      if (token === "clerk-expired") return { sub: ownerId, sid: "sess_owner", exp: 1 };
      if (token === "clerk-foreign") return { sub: "user_foreign", sid: "sess_foreign", exp: Math.floor(Date.now() / 1000) + 120 };
      if (token === "clerk-boundary") return { sub: ownerId, sid: "sess_owner", exp: Math.floor(Date.now() / 1000) + 1 };
      if (token !== "clerk-fixture") throw new Error("Not Clerk");
      return { sub: ownerId, sid: "sess_owner", exp: Math.floor(Date.now() / 1000) + 120 };
    } }) });
  received = undefined;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => { received = new Headers(init?.headers); return Response.json({ submission: "accepted" }); });
});
afterEach(async () => {
  const closedBeforeAppShutdown = lookupEnd.mock.calls.length;
  await app.shutdownBrowserApprovals?.(); expect(lookupEnd).toHaveBeenCalledTimes(closedBeforeAppShutdown);
  await lookup.close(); expect(lookupEnd).toHaveBeenCalledOnce();
  await app.shutdownPostHog(); vi.restoreAllMocks(); vi.unstubAllEnvs(); await destroyTestPlatformDb(db);
});
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
it.each(deficientClerkTokens)("an actual app-session exchange cannot turn %s into routine owner authority", async token => {
  const exchanged = await app.request("/api/auth/app-session", { method: "POST", headers: { host: "app.matrix-os.com",
    authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ redirectTo: "/" }) });
  expect(exchanged.status).toBe(200); // Keep the existing generic app-session routing contract.
  const cookie = exchanged.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
  expect(await submit({ cookie })).toBeNull();
});
it.each(deficientClerkTokens)("actual code-cookie renewal cannot turn %s into routine owner authority", async token => {
  const renewed = await app.request("/", { headers: { host: "code.matrix-os.com", authorization: `Bearer ${token}` } });
  expect(renewed.status).toBe(200);
  const cookie = renewed.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
  expect(cookie).toContain("matrix_code_session=");
  expect(await submit({ cookie })).toBeNull();
});
async function browserSession(sessionProvenance: "clerk-browser" | "clerk-device" | undefined = undefined, strong = false,
  timing: { now?: number; expiresInSec?: number } = {}) {
  return issueSyncJwt({ secret: JWT_SECRET, clerkUserId: ownerId, handle, runtimeSlot: "primary",
    gatewayUrl: `https://app.example.test/vm/${handle}`, sessionProvenance, verifiedHumanBrowser: strong ? true : undefined,
    expiresInSec: 600, ...timing });
}
const sessionCookie = (token: string) => `matrix_app_session=${encodeURIComponent(token)}`;
function responseCookie(response: Response) { return response.headers.getSetCookie().map(value => value.split(";")[0]).join("; "); }
async function cookieClaims(response: Response, name: string) {
  const item = response.headers.getSetCookie().find(value => value.startsWith(name + "="));
  expect(item).toBeTruthy();
  return verifySyncJwt(decodeURIComponent(item!.split(";")[0]!.slice(name.length + 1)), { secret: JWT_SECRET });
}
it.each(["vps", "legacy"])("preserves strong browser provenance through the real %s code renewal across a clock boundary without extending its lifetime", async runtime => {
  const epoch = Math.floor(Date.now() / 1000);
  const source = runtime === "legacy" ? await issueSyncJwt({ secret: JWT_SECRET, clerkUserId: ownerId, handle: "alice",
    gatewayUrl: "https://code.example.test", sessionProvenance: "clerk-browser", verifiedHumanBrowser: true, expiresInSec: 600, now: epoch }) : await browserSession("clerk-browser", true, { now: epoch });
  let clock = epoch * 1000; vi.spyOn(Date, "now").mockImplementation(() => clock);
  const lifetime = sessionIdentity.renewedUserSessionLifetime;
  const sampled = vi.spyOn(sessionIdentity, "renewedUserSessionLifetime").mockImplementation((...args) => {
    const result = lifetime(...args); clock += 1000; return result;
  });
  if (runtime === "legacy") await db.executor.updateTable("user_machines").set({ deleted_at: new Date().toISOString() }).where("machine_id", "=", machineId).execute();
  const renewed = await app.request("/", { headers: { host: "code.matrix-os.com", authorization: `Bearer ${source.token}` } });
  if (runtime === "legacy") await db.executor.updateTable("user_machines").set({ deleted_at: null }).where("machine_id", "=", machineId).execute();
  expect(renewed.status).toBe(200);
  const claims = await cookieClaims(renewed, "matrix_code_session");
  expect(sampled).toHaveBeenCalledOnce();
  expect(claims.verified_human_browser).toBe(true); expect(claims.exp).toBeLessThanOrEqual(source.claims.exp);
  expect(verifyRoutineActionProof(await submit({ cookie: responseCookie(renewed) }) ?? undefined, tuple, secret)).toMatchObject(tuple);
});
it("uses the same checked issuance epoch when the Clerk gate crosses its expiry boundary during app exchange", async () => {
  const epoch = Math.floor(Date.now() / 1000); let clock = epoch * 1000;
  vi.spyOn(Date, "now").mockImplementation(() => clock);
  const predicate = clerkSessions.hasVerifiedClerkBrowserSession;
  const checked = vi.spyOn(clerkSessions, "hasVerifiedClerkBrowserSession").mockImplementation((...args) => {
    const result = predicate(...args); clock += 1000; return result;
  });
  const exchanged = await app.request("/api/auth/app-session", { method: "POST", headers: { host: "app.matrix-os.com",
    authorization: "Bearer clerk-boundary", "content-type": "application/json" }, body: JSON.stringify({ redirectTo: "/" }) });
  expect(exchanged.status).toBe(200); expect(checked).toHaveBeenCalledOnce();
  const claims = await cookieClaims(exchanged, "matrix_app_session");
  expect(claims.verified_human_browser).toBe(true); expect(claims.iat).toBe(epoch); expect(claims.exp).toBe(epoch + 12 * 60 * 60);
});
it("fresh genuine Clerk code login issues stronger browser provenance without changing the normal twelve-hour routing lifetime", async () => {
  const before = Math.floor(Date.now() / 1000);
  const response = await app.request("/", { headers: { host: "code.matrix-os.com", authorization: "Bearer clerk-fixture" } });
  expect(response.status).toBe(200);
  const claims = await cookieClaims(response, "matrix_code_session");
  expect(claims.verified_human_browser).toBe(true); expect(claims.exp).toBeGreaterThanOrEqual(before + 12 * 60 * 60);
  expect(verifyRoutineActionProof(await submit({ cookie: responseCookie(response) }) ?? undefined, tuple, secret)).toMatchObject(tuple);
});
it("does not upgrade a weak browser session at the actual legacy code-renewal issuer", async () => {
  const legacy = await issueSyncJwt({ secret: JWT_SECRET, clerkUserId: ownerId, handle: "alice",
    gatewayUrl: "https://code.example.test", sessionProvenance: "clerk-browser", expiresInSec: 600 });
  await db.executor.updateTable("user_machines").set({ deleted_at: new Date().toISOString() }).where("machine_id", "=", machineId).execute();
  let renewed: Response;
  try { renewed = await app.request("/", { headers: { host: "code.matrix-os.com", authorization: `Bearer ${legacy.token}` } }); }
  finally { await db.executor.updateTable("user_machines").set({ deleted_at: null }).where("machine_id", "=", machineId).execute(); }
  expect(renewed.status).toBe(200);
  expect((await cookieClaims(renewed, "matrix_code_session")).verified_human_browser).toBeUndefined();
  expect(await submit({ cookie: responseCookie(renewed) })).toBeNull();
});
it("drops stronger browser provenance if the signed source expires while the real code upstream is pending", async () => {
  const epoch = Math.floor(Date.now() / 1000), source = await browserSession("clerk-browser", true, { now: epoch, expiresInSec: 1 });
  let clock = epoch * 1000; vi.spyOn(Date, "now").mockImplementation(() => clock);
  vi.mocked(globalThis.fetch).mockImplementationOnce(async (_url, init) => {
    received = new Headers(init?.headers); clock = source.claims.exp * 1000;
    return Response.json({ submission: "accepted" });
  });
  const renewed = await app.request("/", { headers: { host: "code.matrix-os.com", authorization: `Bearer ${source.token}` } });
  expect(renewed.status).toBe(200);
  const claims = await cookieClaims(renewed, "matrix_code_session");
  expect(claims.verified_human_browser).toBeUndefined(); expect(claims.exp).toBeLessThanOrEqual(source.claims.exp);
  expect(await submit({ cookie: responseCookie(renewed) })).toBeNull();
});
it.each([undefined, "clerk-browser", "clerk-device"] as const)("does not upgrade %s legacy/generic transport during app exchange or code renewal", async provenance => {
  const legacy = await browserSession(provenance);
  const exchanged = await app.request("/api/auth/app-session", { method: "POST", headers: { host: "app.matrix-os.com",
    authorization: `Bearer ${legacy.token}`, "content-type": "application/json" }, body: JSON.stringify({ redirectTo: "/" }) });
  expect(exchanged.status).toBe(200);
  expect((await cookieClaims(exchanged, "matrix_app_session")).verified_human_browser).toBeUndefined();
  expect(await submit({ cookie: responseCookie(exchanged), "x-matrix-verified-human-browser": "true" })).toBeNull();
  const renewed = await app.request("/", { headers: { host: "code.matrix-os.com", authorization: `Bearer ${legacy.token}` } });
  expect(renewed.status).toBe(200);
  expect((await cookieClaims(renewed, "matrix_code_session")).verified_human_browser).toBeUndefined();
  expect(await submit({ cookie: responseCookie(renewed) })).toBeNull();
});
it("expired strong provenance within the ordinary clock tolerance cannot mint consent, while a separate current Clerk cookie can", async () => {
  const expired = await browserSession("clerk-browser", true, { now: Math.floor(Date.now() / 1000) - 61, expiresInSec: 60 });
  expect(await submit({ cookie: sessionCookie(expired.token) })).toBeNull();
  expect(verifyRoutineActionProof(await submit({ cookie: sessionCookie(expired.token) + "; __session=clerk-fixture" }) ?? undefined, tuple, secret)).toMatchObject(tuple);
});
it("rejects tampered marker payloads and a foreign Clerk cookie paired with a strong owner session", async () => {
  const legacy = await browserSession(); const [head, encoded, signature] = legacy.token.split(".");
  const altered = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(encoded!, "base64url").toString("utf8")), verified_human_browser: true })).toString("base64url");
  const strong = await browserSession("clerk-browser", true);
  for (const cookie of [sessionCookie(`${head}.${altered}.${signature}`), sessionCookie(strong.token) + "; __session=clerk-foreign"]) {
    received = undefined;
    const response = await app.request(`/vm/${handle}${path}`, { method: "POST", headers: { host: "app.matrix-os.com", cookie, "content-type": "application/json" }, body: JSON.stringify(body) });
    if (response.status === 200) {
      expect(response.headers.get("content-type")).toContain("text/html"); expect(await response.text()).toContain("Clerk");
    } else expect([401, 403]).toContain(response.status);
    expect(received).toBeUndefined();
  }
});
it("keeps unchanged Computer selection as a safe marker downgrade with independent fresh-Clerk fallback", async () => {
  const strong = await browserSession("clerk-browser", true);
  const selected = await app.request("/api/auth/runtime-selection", { method: "POST", headers: { host: "api.matrix-os.com",
    authorization: `Bearer ${strong.token}`, "content-type": "application/json" }, body: JSON.stringify({ slot: "primary" }) });
  expect(selected.status).toBe(200); const token = (await selected.json()).accessToken;
  const claims = await verifySyncJwt(token, { secret: JWT_SECRET });
  expect(claims.verified_human_browser).toBeUndefined(); expect(claims.exp).toBeLessThanOrEqual(strong.claims.exp);
  expect(await submit({ authorization: `Bearer ${token}` })).toBeNull();
  expect(verifyRoutineActionProof(await submit({ authorization: `Bearer ${token}`, cookie: "__session=clerk-fixture" }) ?? undefined, tuple, secret)).toMatchObject(tuple);
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

async function verifiedRequest(proof: string | null | undefined, input = tuple, headers: Record<string, string> = {}, rawBody?: string) {
  return app.request(`/internal/containers/${handle}/routine-actions/verify`, { method: "POST", headers: {
    authorization: `Bearer ${buildPlatformVerificationToken(handle, secret)}`, "content-type": "application/json",
    ...(proof ? { [ROUTINE_ACTION_PROOF_HEADER]: proof } : {}), ...headers,
  }, body: rawBody ?? JSON.stringify(input) });
}
it("registers the actual verifier with browser grants disabled and checks the persisted owned Computer", async () => {
  const proof = await submit({ authorization: "Bearer clerk-fixture" });
  const response = await verifiedRequest(proof);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect((await response.json()).verified).toMatchObject({ ...tuple, purpose: "routine_cli_owner_action" });
});

it("does not return an exact-operation proof that expires during the registered machine lookup", async () => {
  const proof = await submit({ authorization: "Bearer clerk-fixture" });
  const payload = JSON.parse(Buffer.from(proof!.split(".")[0]!, "base64url").toString("utf8"));
  vi.spyOn(lookup, "resolveMachine").mockImplementationOnce(async () => {
    vi.spyOn(Date, "now").mockReturnValue(payload.expiresAt);
    return { machineId, clerkUserId: ownerId, runtimeSlot: "primary", status: "running" };
  });
  expect((await verifiedRequest(proof)).status).toBe(403);
});

it.each([false, true])("bounds a slow registered exact-operation verifier body with authenticated=%s", async authenticated => {
  const proof = await submit({ authorization: "Bearer clerk-fixture" });
  let controller!: ReadableStreamDefaultController<Uint8Array>, cancelled = false;
  const request = new Request(`http://localhost/internal/containers/${handle}/routine-actions/verify`, { method: "POST", headers: {
    authorization: authenticated ? `Bearer ${buildPlatformVerificationToken(handle, secret)}` : "Bearer unrelated",
    [ROUTINE_ACTION_PROOF_HEADER]: proof!,
  }, body: new ReadableStream<Uint8Array>({ start(value) { controller = value; value.enqueue(new TextEncoder().encode("{")); },
    cancel() { cancelled = true; } }), duplex: "half" } as RequestInit);
  const pending = app.request(request);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = await Promise.race([pending, new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), authenticated ? 5500 : 150); })]);
    expect(response?.status).toBe(authenticated ? 408 : 401);
    expect(response?.headers.get("cache-control")).toBe("private, no-store");
    if (authenticated) expect(cancelled).toBe(true);
  } finally {
    clearTimeout(timer);
    if (!cancelled) controller.close();
    await pending;
  }
  expect((await verifiedRequest(proof)).status).toBe(200);
}, 10_000);
it("the registered verifier requires both machine transport and the exact preexisting owner proof", async () => {
  const proof = await submit({ authorization: "Bearer clerk-fixture" });
  for (const authorization of ["", "Bearer wrong-transport"]) expect((await verifiedRequest(proof, tuple, { authorization })).status).toBe(401);
  expect((await verifiedRequest(undefined)).status).toBe(403);
  expect((await verifiedRequest("forged-caller-proof")).status).toBe(403);
  const encoded = proof!.split(".")[0]!;
  const forged = `${encoded}.${createHmac("sha256", buildPlatformVerificationToken(handle, secret)).update(`matrix-routine-cli-owner-action:v1\0${encoded}`).digest("hex")}`;
  expect((await verifiedRequest(forged)).status).toBe(403);
  for (const patch of [{ ownerId: "user_foreign" }, { runtimeSlot: "other" }, { machineId: "replacement" },
    { actionDigest: "b".repeat(64) }, { decision: "decline" }, { clientRequestId: "de000000-0000-4000-8000-000000000002" },
    { challengeId: `rcact_${"b".repeat(32)}` }]) expect((await verifiedRequest(proof, { ...tuple, ...patch } as typeof tuple)).status).toBe(403);
  expect((await verifiedRequest(proof, { ...tuple, handle: "foreign-pc" } as typeof tuple)).status).toBe(400);
  const future = Date.now() + 61_000; vi.spyOn(Date, "now").mockReturnValue(future);
  expect((await verifiedRequest(proof)).status).toBe(403);
});
it("the registered verifier bounds and strictly validates body, handle and query inputs", async () => {
  const proof = await submit({ authorization: "Bearer clerk-fixture" });
  expect((await verifiedRequest(proof, tuple, {}, "{")).status).toBe(400);
  expect((await verifiedRequest(proof, tuple, {}, JSON.stringify({ ...tuple, modelOwner: "not-authority" }))).status).toBe(400);
  expect((await verifiedRequest(proof, tuple, {}, " ".repeat(4001))).status).toBe(413);
  const url = `/internal/containers/${handle}/routine-actions/verify?ownerId=foreign`;
  expect((await app.request(url, { method: "POST", headers: { authorization: `Bearer ${buildPlatformVerificationToken(handle, secret)}` }, body: JSON.stringify(tuple) })).status).toBe(400);
});
it.each(["owner", "machine", "slot", "stopped", "deleted"])("the registered verifier refuses a now-%s registry binding", async changed => {
  const proof = await submit({ authorization: "Bearer clerk-fixture" });
  const patch = changed === "owner" ? { clerk_user_id: "user_foreign" }
    : changed === "machine" ? { machine_id: "replacement_machine" }
    : changed === "slot" ? { runtime_slot: "other" }
    : changed === "stopped" ? { status: "stopped" as const } : { deleted_at: new Date().toISOString() };
  await db.executor.updateTable("user_machines").set(patch).where("machine_id", "=", machineId).execute();
  expect((await verifiedRequest(proof)).status).toBe(403);
});
it("the registered verifier reports unavailable lookup and closed resources without granting consent", async () => {
  const proof = await submit({ authorization: "Bearer clerk-fixture" });
  const unavailable = vi.spyOn(lookup, "resolveMachine").mockRejectedValueOnce(new Error("synthetic lookup unavailable"));
  expect((await verifiedRequest(proof)).status).toBe(503);
  unavailable.mockRestore(); await lookup.close();
  expect((await verifiedRequest(proof)).status).toBe(503);
});
it("caps eight active registered verifications and releases admission after blocked lookups finish", async () => {
  const proof = await submit({ authorization: "Bearer clerk-fixture" });
  const releases: Array<() => void> = [];
  const blocked = vi.spyOn(lookup, "resolveMachine").mockImplementation(() => new Promise(resolve => {
    releases.push(() => resolve({ machineId, clerkUserId: ownerId, runtimeSlot: "primary", status: "running" }));
  }));
  const pending = Array.from({ length: 8 }, () => verifiedRequest(proof));
  let ninth: Promise<Response> | undefined, ninthStatus: number | undefined;
  try {
    await vi.waitFor(() => expect(releases).toHaveLength(8));
    ninth = verifiedRequest(proof).then(response => { ninthStatus = response.status; return response; });
    await vi.waitFor(() => expect(ninthStatus).toBe(503));
  } finally {
    releases.splice(0).forEach(release => release());
    await Promise.allSettled([...pending, ...(ninth ? [ninth] : [])]);
    blocked.mockRestore();
  }
  expect((await Promise.all(pending)).map(response => response.status)).toEqual(Array(8).fill(200));
  expect((await verifiedRequest(proof)).status).toBe(200);
});
