import { afterEach, expect, it, vi } from "vitest";
import { createApp } from "../../packages/platform/src/main.js";
import { BrowserApprovalMachineLookup } from "../../packages/platform/src/browser-approval-machine-lookup.js";
import { insertUserMachine, type PlatformDB } from "../../packages/platform/src/db.js";
import { buildPlatformVerificationToken } from "../../packages/platform/src/platform-token.js";
import { issueSyncJwt } from "../../packages/platform/src/sync-jwt.js";
import { cleanupProxyRoutingTest, JWT_SECRET, setupProxyRoutingTest, stubOrchestrator } from "./proxy-routing-test-utils.js";

const secret = "synthetic-dev-platform-key";
const handle = "test-owner-dev";
const ownerId = "user_browserdev";
const machineId = "178ca19d-9760-4e67-a221-62bedf393b90";
const replacementId = "278ca19d-9760-4e67-a221-62bedf393b90";
const tuple = { handle, actorId: ownerId, runtimeSlot: "dev", chatId: "chat_browser",
  runId: "run_browser", approvalId: "browser_one", clientRequestId: "req_browser",
  browserDecision: "allow_once", actionDigest: "a".repeat(64), leaseEpoch: "378ca19d-9760-4e67-a221-62bedf393b90",
  challengeRevision: 0, scopeVersion: 1 };
const proofHeader = "x-matrix-browser-approval-proof";
let db: PlatformDB | undefined;
let lookup: BrowserApprovalMachineLookup | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await lookup?.close();
  lookup = undefined;
  if (db) await cleanupProxyRoutingTest(db);
  db = undefined;
});

async function fixture() {
  vi.stubEnv("PLATFORM_JWT_SECRET", JWT_SECRET);
  db = await setupProxyRoutingTest();
  await insertUserMachine(db, { machineId, clerkUserId: ownerId, handle, runtimeSlot: "dev",
    provisioningClass: "customer", status: "running", activationState: "authorized",
    hetznerServerId: 101, publicIPv4: "203.0.113.21", imageVersion: "dev",
    serverType: "cpx22", provisionedAt: "2026-10-16T00:00:00.000Z" });
  let liveMachine = machineId;
  let onLookup: (() => void) | undefined;
  lookup = new BrowserApprovalMachineLookup({ databaseUrl: "postgresql://synthetic.invalid/platform", poolFactory: (() => ({
    connect: async () => ({ query: async (statement: string) => {
      if (statement.startsWith("SELECT")) {
        onLookup?.();
        return { rows: [{ machine_id: liveMachine, clerk_user_id: ownerId, runtime_slot: "dev",
          status: "running", provisioning_class: "customer" }] };
      }
      return { rows: [] };
    }, release() {} }),
    on() {}, end: async () => {},
  })) as never });
  const now = Date.now();
  const scope = { handle, machineId, ownerId, runtimeSlot: "dev", chatId: tuple.chatId,
    expiresAt: new Date(now + 30_000).toISOString() };
  const app = (raw = JSON.stringify(scope), global = false) => createApp({
    db: db!, orchestrator: stubOrchestrator(), platformSecret: secret, browserApprovalMachineLookup: lookup,
    env: { ...process.env, MATRIX_SUPERVISED_BROWSER_DEV_SCOPE: raw,
      MATRIX_SUPERVISED_BROWSER_APPROVALS_ENABLED: String(global) },
  });
  let forwarded: Headers | undefined;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    forwarded = new Headers(init?.headers);
    return Response.json({ submission: "accepted" });
  });
  const token = async (human: boolean, userId = ownerId) => (await issueSyncJwt({
    secret: JWT_SECRET, clerkUserId: userId, handle, runtimeSlot: "dev",
    gatewayUrl: `https://app.matrix-os.com/vm/${handle}?runtime=dev`,
    sessionProvenance: "clerk-browser", ...(human ? { verifiedHumanBrowser: true as const } : {}),
  })).token;
  const submit = async (target: ReturnType<typeof app>, options: { chatId?: string; decision?: string; human?: boolean; owner?: string; slot?: string } = {}) => {
    forwarded = undefined;
    const response = await target.request(`/vm/${handle}/~runtime/${options.slot ?? "dev"}/api/chats/${options.chatId ?? tuple.chatId}/runs/${tuple.runId}/approvals/${tuple.approvalId}`, {
      method: "POST",
      headers: { host: "app.matrix-os.com", authorization: `Bearer ${await token(options.human ?? true, options.owner)}`,
        "content-type": "application/json", [proofHeader]: "caller-forged-proof" },
      body: JSON.stringify({ clientRequestId: tuple.clientRequestId, decision: "approve", actionDigest: tuple.actionDigest,
        browserApproval: { kind: "shared_chrome", decision: options.decision ?? tuple.browserDecision,
          leaseEpoch: tuple.leaseEpoch, challengeRevision: 0, scopeVersion: 1 } }),
    });
    return { response, proof: (forwarded as Headers | undefined)?.get(proofHeader) ?? null };
  };
  const verify = (target: ReturnType<typeof app>, proof: string | null, expected = tuple) =>
    target.request(`/internal/containers/${handle}/browser-approvals/verify`, {
      method: "POST",
      headers: { authorization: `Bearer ${buildPlatformVerificationToken(handle, secret)}`, "content-type": "application/json",
        ...(proof ? { [proofHeader]: proof } : {}) },
      body: JSON.stringify({ kind: "decision", tuple: expected }),
    });
  return { now, scope, app, submit, verify, replaceMachine: () => { liveMachine = replacementId; },
    atLookup: (callback: () => void) => { onLookup = callback; } };
}

it("signs and verifies one temporary Dev Chat through the composed owner proxy and machine verifier", async () => {
  const f = await fixture();
  const app = f.app();
  const { response, proof } = await f.submit(app);
  expect(response.status).toBe(200);
  expect(proof).toBeTruthy();
  expect(proof).not.toBe("caller-forged-proof");
  const verified = await f.verify(app, proof);
  expect(verified.status).toBe(200);
  expect(await verified.json()).toMatchObject({ verified: { ...tuple, expiresAt: Date.parse(f.scope.expiresAt) } });
  expect((await f.verify(app, null)).status).toBe(403);
  expect((await f.verify(app, proof, { ...tuple, chatId: "chat_other" })).status).toBe(403);
  for (const options of [{ chatId: "chat_other" }, { human: false }, { owner: "user_other" },
    { slot: "primary" }, { decision: "allow_in_chat" }]) {
    expect((await f.submit(app, options)).proof).toBeNull();
  }
  f.replaceMachine();
  expect((await f.submit(app)).proof).toBeNull();
  expect((await f.verify(app, proof)).status).toBe(403);
  const rotated = f.app(JSON.stringify({ ...f.scope, machineId: replacementId }));
  expect((await f.verify(rotated, proof)).status).toBe(403);
});

it("fails closed on invalid or conflicting scope and rechecks expiry after the live lookup", async () => {
  const f = await fixture();
  const app = f.app();
  const { proof } = await f.submit(app);
  expect(proof).toBeTruthy();
  for (const invalid of ["malformed", JSON.stringify({ ...f.scope, runtimeSlot: "primary" }),
    JSON.stringify({ ...f.scope, expiresAt: new Date(f.now + 7_260_000).toISOString() }),
    JSON.stringify({ ...f.scope, expiresAt: new Date(f.now - 1).toISOString() })]) {
    const disabled = f.app(invalid);
    expect((await f.submit(disabled)).proof).toBeNull();
    expect((await f.verify(disabled, proof)).status).toBe(404);
  }
  const conflicting = f.app(JSON.stringify(f.scope), true);
  expect((await f.submit(conflicting)).proof).toBeNull();
  expect((await f.verify(conflicting, proof)).status).toBe(404);
  f.atLookup(() => { vi.spyOn(Date, "now").mockReturnValue(Date.parse(f.scope.expiresAt)); });
  expect((await f.verify(app, proof)).status).toBe(403);
  expect((await f.submit(app)).proof).toBeNull();
});
