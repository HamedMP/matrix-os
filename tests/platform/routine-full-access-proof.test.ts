import { createHash, createHmac } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { authenticatedApprovalProxyProof } from "../../packages/platform/src/canonical-owner-approval-proxy.js";
import { createClerkAuth } from "../../packages/platform/src/clerk-auth.js";
import { mintRoutineFullAccessProof, verifyRoutineFullAccessProof } from "../../packages/platform/src/routine-full-access-proof.js";
import { mintRoutineActionProof, verifyRoutineActionProof } from "../../packages/platform/src/routine-action-proof.js";
import { ROUTINE_FULL_ACCESS_SCOPE_HEADER, ROUTINE_FULL_ACCESS_PROOF_HEADER, ROUTINE_ACTION_PROOF_HEADER, RoutineFullAccessTupleSchema,
  routineFullAccessTurnRequestIdentity } from "@matrix-os/contracts";
import { browserApprovalProofHeader } from "../../packages/platform/src/browser-chat-approval-proof.js";
import { buildCodeDomainProxyHeaders, shouldForwardProxyHeader } from "../../packages/platform/src/session-routing-proxy.js";
import { buildPlatformVerificationToken } from "../../packages/platform/src/platform-token.js";
import { buildPlatformWebSocketUpgradeHeaders } from "../../packages/platform/src/session-routing-websocket.js";

const secret = "synthetic-purpose-separated-full-origin-secret";
const challengeId = `rcfull_${"a".repeat(32)}`;
const path = `/api/chats/chat_owner/routine-cli/full-access/challenges/${challengeId}/decision`;
const body = { scopeDigest: "b".repeat(64), decision: "approve", clientRequestId: "de000000-0000-4000-8000-000000000001" };
const machine = { machineId: "machine_owner", handle: "owner-pc", runtimeSlot: "primary", provisioningClass: "customer" as const, clerkUserId: "user_owner" };
const identity = { handle: machine.handle, userId: machine.clerkUserId, runtimeSlot: machine.runtimeSlot, source: "auth" as const };
const clerkAuth = createClerkAuth({ verifyToken: async () => ({ sub: identity.userId, sid: "session_owner", exp: Math.floor(Date.now() / 1000) + 120 }) });
afterEach(() => vi.restoreAllMocks());
const scopeId = `rcfull_${"c".repeat(32)}`;
const turn = { clientRequestId: "req_MixedCaseRequest", baseRevision: 5, parts: [{ type: "text" as const, text: "Inspect the approved routine" }],
  selection: { instanceId: "claude_code_default", model: "claude-sonnet-4-5" }, interactionMode: "default", permissionMode: "full_access" };
type Input = Parameters<typeof authenticatedApprovalProxyProof>[0];
async function proxy(value: unknown = body, patch: Partial<Input> = {}, headers: Record<string, string> = {}) {
  const selectedPath = patch.path ?? path;
  return authenticatedApprovalProxyProof({ request: new Request(`https://app.example.test/vm/${machine.handle}${selectedPath}`, {
    method: "POST", headers: { authorization: "Bearer synthetic-clerk", ...headers }, body: JSON.stringify(value) }),
    method: "POST", path: selectedPath, handle: machine.handle, machine, identity, platformSecret: secret, clerkAuth, ...patch });
}
function parsed(proof: unknown) {
  expect(proof).toEqual(expect.any(String));
  if (typeof proof !== "string") throw new Error("Proof absent");
  return JSON.parse(Buffer.from(proof.split(".")[0]!, "base64url").toString("utf8"));
}

it("the actual existing proxy mints a distinct Full Access scope-decision proof from a genuine verified owner-browser session", async () => {
  const proof = await authenticatedApprovalProxyProof({ request: new Request(`https://app.example.test/vm/${machine.handle}${path}`, {
    method: "POST", headers: { authorization: "Bearer synthetic-clerk" }, body: JSON.stringify(body) }),
    method: "POST", path, handle: machine.handle, machine, identity, platformSecret: secret, clerkAuth });
  expect(proof).toEqual(expect.any(String));
  if (typeof proof !== "string") throw new Error("Full Access purpose proof absent");
  const payload = JSON.parse(Buffer.from(proof.split(".")[0]!, "base64url").toString("utf8"));
  expect(payload).toMatchObject({ purpose: "routine_cli_full_access_origin", kind: "scope_decision", version: 1,
    handle: machine.handle, runtimeSlot: machine.runtimeSlot, ownerId: identity.userId, machineId: machine.machineId,
    chatId: "chat_owner", challengeId, ...body });
});

it("binds an ordinary fresh Claude turn to the full canonical parsed request, scope selector and preserved request ID", async () => {
  const proof = await proxy(turn, { path: "/api/chats/chat_owner/turns" }, { [ROUTINE_FULL_ACCESS_SCOPE_HEADER]: scopeId });
  const value = parsed(proof), digest = createHash("sha256").update(routineFullAccessTurnRequestIdentity(turn)).digest("hex");
  const expected = RoutineFullAccessTupleSchema.parse({ kind: "turn", handle: machine.handle, runtimeSlot: machine.runtimeSlot,
    machineId: machine.machineId, ownerId: identity.userId, chatId: "chat_owner", scopeId, clientRequestId: turn.clientRequestId, requestDigest: digest });
  expect(value).toMatchObject(expected);
  expect(verifyRoutineFullAccessProof(proof as string, expected, secret)).toMatchObject(expected);
  expect(browserApprovalProofHeader(proof as string)).toBe(ROUTINE_FULL_ACCESS_PROOF_HEADER);
  for (const patch of [{ ownerId: "user_foreign" }, { handle: "foreign-pc" }, { machineId: "replacement" }, { runtimeSlot: "other" },
    { chatId: "chat_foreign" }, { scopeId: challengeId }, { clientRequestId: "req_replayed" }, { requestDigest: "0".repeat(64) }]) {
    expect(verifyRoutineFullAccessProof(proof as string, { ...expected, ...patch }, secret), JSON.stringify(patch)).toBeNull();
  }
  for (const change of [{ ...turn, baseRevision: 6 }, { ...turn, parts: [{ type: "text" as const, text: "Different operation" }] }]) {
    expect(createHash("sha256").update(routineFullAccessTurnRequestIdentity(change)).digest("hex")).not.toBe(digest);
  }
});

it("binds an explicitly authorized Computer when the browser session still names another runtime slot", async () => {
  const proof = await proxy(body, { identity: { ...identity, runtimeSlot: "previous-computer" } });
  const value = parsed(proof);
  expect(value).toMatchObject({
    handle: machine.handle,
    runtimeSlot: machine.runtimeSlot,
    machineId: machine.machineId,
    ownerId: identity.userId,
  });
});

it.each([undefined, "", "rcfull_fake"])("does not mint a turn proof from full_access mode without a valid scope reference %s", async scope => {
  expect(await proxy(turn, { path: "/api/chats/chat_owner/turns" }, scope === undefined ? {} : { [ROUTINE_FULL_ACCESS_SCOPE_HEADER]: scope })).toBeNull();
});

it.each(["queued-turns", "turns/retry", "turns/continue", "runs/run_one/turns", "terminal/turns"])("does not attest the non-ordinary %s path", async suffix => {
  expect(await proxy(turn, { path: `/api/chats/chat_owner/${suffix}` }, { [ROUTINE_FULL_ACCESS_SCOPE_HEADER]: scopeId })).toBeNull();
});

it("does not mint for other harnesses, supervised/plan modes, injected body authority or nondefault interaction", async () => {
  for (const patch of [{ permissionMode: "supervised" }, { permissionMode: "plan" }, { interactionMode: "plan" },
    { selection: { ...turn.selection, instanceId: "codex_default" } }, { origin: "human" }]) {
    expect(await proxy({ ...turn, ...patch }, { path: "/api/chats/chat_owner/turns" }, { [ROUTINE_FULL_ACCESS_SCOPE_HEADER]: scopeId })).toBeNull();
  }
  expect(await proxy({ ...body, permissionMode: "full_access" })).toBeNull();
});

it("rejects missing/foreign routed identity, Computer and runtime even with a verified Clerk browser", async () => {
  for (const patch of [{ machine: undefined }, { handle: "foreign-pc" }, { machine: { ...machine, machineId: undefined } },
    { machine: { ...machine, clerkUserId: "user_foreign" } },
    { identity: { ...identity, source: "static-route" as const } }, { identity: { ...identity, source: "mobile-session" as const } }]) {
    expect(await proxy(body, patch)).toBeNull();
  }
});

it("requires an unexpired matching real Clerk sid/expiry or an already strong signed browser session", async () => {
  for (const claims of [{ sub: identity.userId }, { sub: identity.userId, sid: "session" },
    { sub: identity.userId, sid: " ", exp: Math.floor(Date.now() / 1000) + 120 },
    { sub: "user_foreign", sid: "session", exp: Math.floor(Date.now() / 1000) + 120 },
    { sub: identity.userId, sid: "session", exp: 1 }, { sub: identity.userId, sid: "session", exp: 1.5 },
    { sub: identity.userId, sid: "session", exp: "invalid" }]) {
    expect(await proxy(body, { clerkAuth: createClerkAuth({ verifyToken: async () => claims }) })).toBeNull();
  }
  const exp = Math.floor(Date.now() / 1000) + 20;
  const strong = { ...identity, sessionProvenance: "clerk-browser" as const, sessionExpiresAt: exp, verifiedHumanBrowserExpiresAt: exp };
  expect(parsed(await proxy(body, { identity: strong, clerkAuth: undefined })).expiresAt).toBeLessThanOrEqual(exp * 1000);
  for (const source of [{ ...strong, verifiedHumanBrowserExpiresAt: undefined }, { ...strong, sessionExpiresAt: 1 },
    { ...strong, verifiedHumanBrowserExpiresAt: 1 }, { ...strong, sessionProvenance: "clerk-device" as const }, { ...identity, verifiedSyncBearer: true }]) {
    expect(await proxy(body, { identity: source, clerkAuth: undefined })).toBeNull();
  }
  const outage = { ...clerkAuth, verify: vi.fn(async () => { throw new Error("private-provider-outage"); }) };
  expect(await proxy(body, { clerkAuth: outage })).toBeNull();
});

it("keeps exact-operation purpose/domain and transport-key forgery separate, and exposes nonce only for Gateway redemption", async () => {
  const proof = await proxy(), value = parsed(proof);
  const expected = RoutineFullAccessTupleSchema.parse(value.kind === "scope_decision" ? {
    kind: value.kind, handle: value.handle, ownerId: value.ownerId, machineId: value.machineId, runtimeSlot: value.runtimeSlot,
    chatId: value.chatId, challengeId: value.challengeId, scopeDigest: value.scopeDigest, decision: value.decision, clientRequestId: value.clientRequestId,
  } : {});
  const signed = (data: unknown, key = secret) => {
    const encoded = Buffer.from(JSON.stringify(data)).toString("base64url");
    return `${encoded}.${createHmac("sha256", key).update(`matrix-routine-cli-full-access-origin:v1\0${encoded}`).digest("hex")}`;
  };
  for (const data of [{ ...value, purpose: "routine_cli_owner_action" }, { ...value, kind: "turn" }, { ...value, expiresAt: Date.now() - 1 },
    { ...value, expiresAt: Date.now() + 61_000 }, { ...value, nonce: "invalid" }, { ...value, bodyDigest: "0".repeat(64) }, { ...value, runId: "model-self-report" }]) {
    expect(verifyRoutineFullAccessProof(signed(data), expected, secret)).toBeNull();
  }
  expect(verifyRoutineFullAccessProof(signed(value, buildPlatformVerificationToken(machine.handle, secret)), expected, secret)).toBeNull();
  expect(verifyRoutineFullAccessProof((proof as string) + "corrupt", expected, secret)).toBeNull();
  expect(verifyRoutineFullAccessProof("x".repeat(4001), expected, secret)).toBeNull();
  // Platform is a verifier, not a nonce ledger or a consent service.
  expect(verifyRoutineFullAccessProof(proof as string, expected, secret)?.nonce).toBe(value.nonce);
  expect(verifyRoutineFullAccessProof(proof as string, expected, secret)?.nonce).toBe(value.nonce);
  const actionTuple = { handle: machine.handle, runtimeSlot: machine.runtimeSlot, machineId: machine.machineId, ownerId: identity.userId,
    challengeId: `rcact_${"a".repeat(32)}`, actionDigest: body.scopeDigest, decision: body.decision, clientRequestId: body.clientRequestId };
  expect(verifyRoutineActionProof(proof as string, actionTuple, secret)).toBeNull();
  const action = mintRoutineActionProof({ ...actionTuple, method: "POST", path: `/api/routine-cli/actions/${actionTuple.challengeId}/decision`,
    body: JSON.stringify({ actionDigest: actionTuple.actionDigest, decision: body.decision, clientRequestId: body.clientRequestId }), secret, sessionExpiresAt: Date.now() + 60_000 });
  expect(verifyRoutineFullAccessProof(action!, expected, secret)).toBeNull();
});

it("strips caller proofs from every generic/code proxy path while preserving the nonsecret selector", () => {
  for (const header of [ROUTINE_FULL_ACCESS_PROOF_HEADER, ROUTINE_FULL_ACCESS_PROOF_HEADER.toUpperCase()]) {
    expect(shouldForwardProxyHeader(header, "forged-caller-proof")).toBe(false);
    expect(buildCodeDomainProxyHeaders({ [header]: "forged-caller-proof" }, "code.example.test").has(header)).toBe(false);
  }
  expect(shouldForwardProxyHeader(ROUTINE_FULL_ACCESS_SCOPE_HEADER, scopeId)).toBe(true);
});

it("does not carry a caller's Full Access proof through actual WebSocket header construction, including unprivileged/code fallbacks", () => {
  for (const includePlatformProof of [true, false]) for (const isCodeDomain of [true, false]) {
    const headers = buildPlatformWebSocketUpgradeHeaders({ incomingHeaders: { [ROUTINE_FULL_ACCESS_PROOF_HEADER]: "forged-caller-proof",
      [ROUTINE_FULL_ACCESS_PROOF_HEADER.toUpperCase()]: "forged-uppercase-proof", upgrade: "websocket" }, externalHost: "app.matrix-os.com",
      handle: machine.handle, userId: identity.userId, platformSecret: secret, includePlatformProof, isCodeDomain });
    expect(headers).not.toContain("forged-caller-proof");
    expect(headers).not.toContain("forged-uppercase-proof");
    expect(headers).not.toContain(ROUTINE_FULL_ACCESS_PROOF_HEADER);
  }
});

it("also strips the prerequisite exact-operation proof from WebSocket fallbacks", () => {
  for (const includePlatformProof of [true, false]) for (const isCodeDomain of [true, false]) {
    const headers = buildPlatformWebSocketUpgradeHeaders({ incomingHeaders: { [ROUTINE_ACTION_PROOF_HEADER]: "forged-exact-proof",
      [ROUTINE_ACTION_PROOF_HEADER.toUpperCase()]: "forged-exact-uppercase-proof", upgrade: "websocket" }, externalHost: "app.matrix-os.com",
      handle: machine.handle, userId: identity.userId, platformSecret: secret, includePlatformProof, isCodeDomain });
    expect(headers).not.toContain("forged-exact-proof");
    expect(headers).not.toContain("forged-exact-uppercase-proof");
    expect(headers).not.toContain(ROUTINE_ACTION_PROOF_HEADER);
  }
});

it("bounds malformed, oversized and slow decision bodies without minting", async () => {
  expect(await proxy({ ...body, nonce: "injected" })).toBeNull();
  expect(await proxy(" ".repeat(4001))).toEqual({ status: 413 });
  let cancelled = false;
  const request = new Request(`https://app.example.test${path}`, { method: "POST", headers: { authorization: "Bearer synthetic-clerk" },
    body: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("{")); }, cancel() { cancelled = true; } }), duplex: "half" } as RequestInit);
  expect(await proxy(body, { request, timeoutMs: 15 })).toEqual({ status: 408 });
  await vi.waitFor(() => expect(cancelled).toBe(true));
});

it("rejects malformed JSON and invalid UTF-8 without exposing decoder or provider details", async () => {
  for (const [bytes, expected] of [[new TextEncoder().encode("{"), null], [new Uint8Array([0xff]), { status: 400 }]] as const) {
    const request = new Request(`https://app.example.test${path}`, { method: "POST", headers: { authorization: "Bearer synthetic-clerk" }, body: bytes });
    expect(await proxy(body, { request })).toEqual(expected);
  }
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  await proxy(body, { clerkAuth: { ...clerkAuth, verify: async () => { throw new Error("private-provider-token-path"); } } });
  expect(warn.mock.calls).toEqual([["[routine-full-access] Browser session unavailable"]]);
});
