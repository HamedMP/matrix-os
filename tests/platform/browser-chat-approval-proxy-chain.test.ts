import { afterEach, expect, it, vi } from "vitest";
import { createApp } from "../../packages/platform/src/main.js";
import { insertUserMachine, type PlatformDB } from "../../packages/platform/src/db.js";
import { issueSyncJwt } from "../../packages/platform/src/sync-jwt.js";
import { verifyBrowserDecisionProof } from "../../packages/platform/src/browser-chat-approval-proof.js";
import { buildPlatformVerificationToken } from "../../packages/platform/src/platform-token.js";
import { BrowserApprovalMachineLookup } from "../../packages/platform/src/browser-approval-machine-lookup.js";
import { cleanupProxyRoutingTest, JWT_SECRET, setupProxyRoutingTest, stubOrchestrator } from "./proxy-routing-test-utils.js";

let db: PlatformDB | undefined;
let lookup: BrowserApprovalMachineLookup | undefined;
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await lookup?.close(); lookup = undefined; if (db) await cleanupProxyRoutingTest(db); db = undefined; });
it("uses real authenticated Preview routing to replace spoofed browser proof and verifies it online without trusting the machine alone", async () => {
  vi.stubEnv("PLATFORM_JWT_SECRET", JWT_SECRET);
  db = await setupProxyRoutingTest();
  const handle = "pr-1234", actorId = "user_browser", secret = "synthetic-production-platform-key";
  await insertUserMachine(db, { machineId: "browser-machine", clerkUserId: actorId, handle, runtimeSlot: handle, provisioningClass: "preview",
    status: "running", hetznerServerId: 100, publicIPv4: "203.0.113.20", imageVersion: "dev", serverType: "cpx22", provisionedAt: "2026-10-16T00:00:00.000Z" });
  lookup = new BrowserApprovalMachineLookup({ databaseUrl: "postgresql://synthetic.invalid/platform", poolFactory: (() => ({
    connect: async () => ({ query: async () => ({ rows: [{ clerk_user_id: actorId, runtime_slot: handle, status: "running" }] }), release() {} }), on() {}, end: async () => {},
  })) as never });
  const app = createApp({ db, orchestrator: stubOrchestrator(), platformSecret: secret, browserApprovalMachineLookup: lookup,
    env: { ...process.env, MATRIX_SUPERVISED_BROWSER_APPROVALS_ENABLED: "true" } });
  let received: Headers | undefined;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => { received = new Headers(init?.headers); return Response.json({ submission: "accepted" }); });
  const tuple = { handle, actorId, runtimeSlot: handle, chatId: "chat_browser", runId: "run_browser", approvalId: "browser_one", clientRequestId: "req_browser",
    browserDecision: "allow_in_chat" as const, actionDigest: "a".repeat(64), leaseEpoch: "178ca19d-9760-4e67-a221-62bedf393b90", challengeRevision: 0, scopeVersion: 1 as const };
  const token = (await issueSyncJwt({ secret: JWT_SECRET, clerkUserId: actorId, handle, runtimeSlot: handle,
    gatewayUrl: `https://app.matrix-os.com/vm/${handle}`, sessionProvenance: "clerk-browser" })).token;
  const response = await app.request(`/vm/${handle}/api/chats/chat_browser/runs/run_browser/approvals/browser_one`, {
    method: "POST", headers: { host: "app.matrix-os.com", authorization: `Bearer ${token}`, "content-type": "application/json",
      "x-matrix-browser-approval-proof": "caller-forged-proof" }, body: JSON.stringify({ clientRequestId: tuple.clientRequestId, decision: "approve", actionDigest: tuple.actionDigest,
      browserApproval: { kind: "shared_chrome", decision: "allow_in_chat", leaseEpoch: tuple.leaseEpoch, challengeRevision: 0, scopeVersion: 1 } }) });
  expect(response.status).toBe(200);
  const forwardedProof = received?.get("x-matrix-browser-approval-proof") ?? undefined;
  expect(forwardedProof).not.toBe("caller-forged-proof");
  expect(verifyBrowserDecisionProof(forwardedProof, tuple, secret)).toMatchObject(tuple);
  expect(received?.get("x-matrix-custom-mcp-approval-proof")).toBeNull();
  const verifyPath = `/internal/containers/${handle}/browser-approvals/verify`;
  const verifyHeaders = { authorization: `Bearer ${buildPlatformVerificationToken(handle, secret)}`, "content-type": "application/json" };
  expect((await app.request(verifyPath, { method: "POST", headers: verifyHeaders, body: JSON.stringify({ kind: "decision", tuple }) })).status).toBe(403);
  const verified = await app.request(verifyPath, { method: "POST", headers: { ...verifyHeaders, "x-matrix-browser-approval-proof": forwardedProof! }, body: JSON.stringify({ kind: "decision", tuple }) });
  expect(verified.status).toBe(200);
  expect(await verified.json()).toMatchObject({ verified: tuple });
});
