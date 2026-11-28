import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalPreviewDriveTurnBody, CanonicalCreateChatTurnRequestSchema } from "@matrix-os/contracts";
import {
  createManagedTerminalHeaders,
  createManagedTerminalReplyHeaders,
  createManagedTerminalVerifier,
  MANAGED_TERMINAL_NONCE_HEADER,
  MANAGED_TERMINAL_TIMESTAMP_HEADER,
  managedTerminalBodyDigest,
  managedWorkspaceIdFor,
  openManagedTerminalPayload,
  sealManagedTerminalPayload,
} from "@matrix-os/contracts/managed-terminal-proof";
import { MANAGED_TERMINAL_OWNER_GRANT_HEADER, MAX_MANAGED_TERMINAL_WIRE_BYTES, type ManagedTerminalTurnAuthority } from "@matrix-os/contracts/managed-terminal-control";
import { HERDR_TERMINAL_WORKSPACE_ID, TERMINAL_CONTROL_COMMAND } from "@matrix-os/contracts/herdr-terminals";
import { insertUserMachine, updateUserMachine, type PlatformDB, type NewUserMachine } from "../../packages/platform/src/db.js";
import { buildPlatformSyncVerificationToken } from "../../packages/platform/src/platform-token.js";
import { createManagedTerminalControlRoutes } from "../../packages/platform/src/managed-terminal-control-routes.js";
import { authenticatedManagedTerminalProxyProof, verifyManagedTerminalOwnerProof } from "../../packages/platform/src/managed-terminal-owner-proof.js";
import { createApp } from "../../packages/platform/src/main.js";
import { createPrivatePreviewEligibility } from "../../packages/platform/src/private-preview-eligibility.js";
import { createTestPlatformDb, destroyTestPlatformDb } from "./platform-db-test-helper.js";
import { issueSyncJwt } from "../../packages/platform/src/sync-jwt.js";
import { JWT_SECRET, stubOrchestrator } from "./proxy-routing-test-utils.js";

const platformSecret = "fixture-only-platform-signing-key";
const ownerId = "user_terminal_owner";
const source = { machineId: "09ebba5a-5c49-4406-879b-73eab5801437", ownerId, runtimeSlot: "primary" };
const target = { machineId: "b0e47e15-0ef5-47fb-8f7e-6908e20f7f73", ownerId, runtimeSlot: "dev" };
const terminal = { workspaceId: HERDR_TERMINAL_WORKSPACE_ID, tabId: "tt_00000000000000000000000000000042" };
const targetAction = {
  kind: "action" as const, targetMachineId: target.machineId, chatId: "chat_test", runId: "run_test",
  worktreeId: "wt_1111111111111111", ref: terminal, revision: "a".repeat(64), action: { action: "read" as const, lines: 40 },
};
const clientRequestId = "req_terminal";
const turnPath = "/api/chats/chat_test/turns";
const turn = {
  clientRequestId, baseRevision: 1, selection: { instanceId: "codex_default", model: "fixture" },
  interactionMode: "default", permissionMode: "full_access",
  executionRoot: { kind: "worktree", projectId: "proj_fixture", worktreeId: targetAction.worktreeId },
  parts: [{ type: "text", text: "Read terminal" }, { type: "invocation_reference", invocation: TERMINAL_CONTROL_COMMAND },
    { type: "resource_reference", resource: { id: managedWorkspaceIdFor(target.machineId) + ":" + terminal.tabId,
      label: "Test terminal", kind: "terminal_session", revision: targetAction.revision } }],
};
const env = { MATRIX_MANAGED_TERMINAL_CONTROL_ENABLED: "1" };
const edgeSecret = "managed-terminal-edge-fixture";
const candidate = "https://tc-1234567---matrix-platform.example.run.app";
function canaryEnv(expiresAt: number, overrides: Record<string, unknown> = {}): NodeJS.ProcessEnv {
  return {
    ...env,
    EDGE_ROUTER_SECRET: edgeSecret,
    MATRIX_MANAGED_TERMINAL_CONTROL_CANARY_V1: JSON.stringify({
      sourceHandle: "main-computer", source, target, chatId: "chat_test", expiresAt, ...overrides,
    }),
  };
}
const bodyDigest = managedTerminalBodyDigest(canonicalPreviewDriveTurnBody(CanonicalCreateChatTurnRequestSchema.parse(turn)));
let db: PlatformDB;
let now: number;
let action: typeof targetAction & { authority: ManagedTerminalTurnAuthority };

async function ownerGrant(epoch: number, chatId = targetAction.chatId) {
  const path = `/api/chats/${chatId}/turns`;
  const proof = await authenticatedManagedTerminalProxyProof({
    request: new Request("https://app.matrix-os.com" + path, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(turn),
    }),
    path, method: "POST", platformSecret, now,
    machine: {
      machineId: source.machineId, runtimeSlot: source.runtimeSlot, clerkUserId: ownerId, runtimeTokenEpoch: epoch,
      status: "running", activationState: "authorized", provisioningClass: "customer", deletedAt: null, accessClerkUserIds: [],
    },
    identity: {
      userId: ownerId, handle: "main-computer", source: "auth", sessionProvenance: "clerk-browser",
      verifiedHumanBrowserExpiresAt: Math.floor(now / 1000) + 3600,
    },
  });
  if (typeof proof !== "string") throw new Error("Fixture owner grant missing");
  return { proof, clientRequestId, bodyDigest };
}

function machine(values: Partial<NewUserMachine> & Pick<NewUserMachine, "machineId" | "handle" | "runtimeSlot">): NewUserMachine {
  return {
    clerkUserId: ownerId, status: "running", provisioningClass: "customer", activationState: "authorized",
    publicIPv4: "203.0.113.20", provisionedAt: new Date(now).toISOString(), ...values,
  };
}

function machineKey(record: typeof source | typeof target, handle: string, epoch = 1) {
  return buildPlatformSyncVerificationToken({ ...record, handle }, platformSecret, epoch);
}

function targetReply(init: RequestInit, value: unknown, status = 200) {
  const headers = new Headers(init.headers);
  const token = machineKey(target, "development-computer");
  const raw = sealManagedTerminalPayload(token, "target-response", JSON.stringify(value));
  return new Response(raw, {
    status,
    headers: createManagedTerminalReplyHeaders(token, raw, status,
      Number(headers.get(MANAGED_TERMINAL_TIMESTAMP_HEADER)), headers.get(MANAGED_TERMINAL_NONCE_HEADER)!),
  });
}

function routes(options: Partial<Pick<Parameters<typeof createManagedTerminalControlRoutes>[0],
  "privatePreviewEligibility" | "env" | "now">> = {}) {
  return createManagedTerminalControlRoutes({ db, platformSecret, env, now: () => now, ...options });
}

function request(app: Pick<ReturnType<typeof routes>, "request">, input: unknown, options: {
  machine?: typeof source | typeof target;
  token?: string;
  issuedAt?: number;
  nonce?: string;
  mutate?: (body: string) => string;
} = {}) {
  const body = JSON.stringify({ source: options.machine ?? source, request: input });
  const headers = createManagedTerminalHeaders(options.token ?? machineKey(source, "main-computer"), "source", body, {
    issuedAt: options.issuedAt ?? now, nonce: options.nonce,
  });
  return { response: app.request("/internal/terminal-control", {
    method: "POST", body: options.mutate ? options.mutate(body) : body, headers,
  }), headers: new Headers(headers) };
}

describe("same-owner managed terminal broker", () => {
  beforeEach(async () => {
    ({ db } = await createTestPlatformDb());
    now = Date.now();
    await insertUserMachine(db, machine({ ...source, handle: "main-computer" }));
    await insertUserMachine(db, machine({ ...target, handle: "development-computer", publicIPv4: "203.0.113.21" }));
    action = { ...targetAction, authority: await ownerGrant(1) };
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await destroyTestPlatformDb(db);
  });

  it("lists only eligible same-owner Computers without a terminal grant or network request", async () => {
    await insertUserMachine(db, machine({
      machineId: "another-owner", handle: "other-computer", clerkUserId: "user_other", runtimeSlot: "primary",
      accessClerkUserIds: [ownerId],
    }));
    await insertUserMachine(db, machine({
      machineId: "awaits-activation", handle: "pending-computer", runtimeSlot: "pending", activationState: "awaiting_billing",
    }));
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const response = await request(routes(), { kind: "computers" }).response;
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      computers: [{ machineId: target.machineId, name: "development-computer", runtimeSlot: "dev" }], partial: false,
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("runs through the composed Platform route and stays disabled without explicit opt-in", async () => {
    const app = (settings: NodeJS.ProcessEnv) => createApp({
      db, platformSecret, env: settings, orchestrator: stubOrchestrator(),
    });
    const proof = { issuedAt: Date.now() };
    const response = await request(app(env), { kind: "computers" }, proof).response;
    expect(response.status).toBe(200);
    expect((await request(app({}), { kind: "computers" }).response).status).toBe(404);
    expect((await request(app({ ...env, MATRIX_PAID_BETA_ENTITLEMENT_STATUS: "disabled" }),
      { kind: "computers" }, proof).response).status).toBe(403);
  });

  it("isolates direct candidate ingress from all general Platform routes", async () => {
    const scopedEnv = canaryEnv(Date.now() + 60_000);
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const app = createApp({ db, platformSecret, env: scopedEnv, orchestrator: stubOrchestrator() });
    expect((await app.request(candidate + "/health")).status).toBe(200);
    expect((await app.request(candidate + "/health", { method: "HEAD" })).status).toBe(200);
    expect((await app.request(candidate + "/.well-known/matrix/server")).status).toBe(404);
    const baseline = createApp({ db, platformSecret, env, orchestrator: stubOrchestrator() });
    expect((await baseline.request(candidate + "/.well-known/matrix/server")).status).toBe(200);
    const primaryTurn = "/vm/main-computer/~runtime/primary" + turnPath;
    const edgeHeaders = { "x-matrix-edge-secret": edgeSecret, "x-forwarded-host": "app.matrix-os.com",
      "x-forwarded-proto": "https", "content-type": "application/json" };
    const post = (path: string, headers = edgeHeaders) => app.request(candidate + path, {
      method: "POST", body: JSON.stringify(turn), headers,
    });
    for (const headers of [
      { ...edgeHeaders, "x-matrix-edge-secret": "" },
      { ...edgeHeaders, "x-matrix-edge-secret": "wrong" },
      { ...edgeHeaders, "x-forwarded-host": "code.matrix-os.com" },
      { ...edgeHeaders, "x-forwarded-proto": "http" },
      { ...edgeHeaders, "origin": "https://foreign.example.test" },
    ]) expect((await post(primaryTurn, headers)).status).toBe(404);
    for (const path of [primaryTurn + "?runtime=dev", primaryTurn + "?token=some-query-capability",
      primaryTurn + "?runtime=primary&runtime=primary", primaryTurn.replace("primary", "dev"),
      "/vm/main-computer" + turnPath, primaryTurn.replace("main-computer", "other-computer"),
      primaryTurn.replace("chat_test", "chat_other"), primaryTurn.replace("/turns", "/queued-turns")]) {
      expect((await post(path)).status).toBe(404);
    }
    expect((await app.request(candidate + primaryTurn, { headers: edgeHeaders })).status).toBe(404);
    expect((await post(primaryTurn)).status).toBe(401);
    expect((await request(app, { kind: "computers" }, { issuedAt: Date.now() }).response).status).toBe(200);
    scopedEnv.MATRIX_MANAGED_TERMINAL_CONTROL_CANARY_V1 = canaryEnv(now).MATRIX_MANAGED_TERMINAL_CONTROL_CANARY_V1;
    expect((await post(primaryTurn)).status).toBe(404);
    expect((await request(app, { kind: "computers" }, { issuedAt: Date.now() }).response).status).toBe(404);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("routes the canary source exclusively to its named DEV runtime and original Chat", async () => {
    const extraPeer = { machineId: "681bbc43-94e5-4201-81c0-dcf40b311e84", ownerId, runtimeSlot: "other" };
    await insertUserMachine(db, machine({ ...extraPeer, handle: "other-owned-computer" }));
    const foreign = { machineId: "0fcedd9b-82da-46e2-aed9-83ace5832aba", ownerId: "user_foreign", runtimeSlot: "primary" };
    await insertUserMachine(db, machine({ ...foreign, clerkUserId: foreign.ownerId, handle: "foreign-computer" }));
    const app = routes({ env: canaryEnv(now + 60 * 60_000) });
    const fetcher = vi.fn(async (_url, init) => targetReply(init, { result: { stdout: "DEV: PASS", exitCode: 0 } }));
    vi.stubGlobal("fetch", fetcher);
    expect(await (await request(app, { kind: "computers" }).response).json()).toEqual({
      computers: [{ machineId: target.machineId, name: "development-computer", runtimeSlot: "dev" }], partial: false,
    });
    expect((await request(app, { kind: "computers" }, {
      machine: target, token: machineKey(target, "development-computer"),
    }).response).status).toBe(403);
    expect((await request(app, { kind: "computers" }, {
      machine: foreign, token: machineKey(foreign, "foreign-computer"),
    }).response).status).toBe(403);
    expect((await request(app, { kind: "terminals", targetMachineId: extraPeer.machineId }).response).status).toBe(404);
    expect((await request(app, { ...action, chatId: "chat_other", authority: await ownerGrant(1, "chat_other") }).response).status).toBe(403);
    expect(fetcher).not.toHaveBeenCalled();
    const result = await request(app, action).response;
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ result: { stdout: "DEV: PASS", exitCode: 0 } });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("fails closed after expiry, on malformed scope, and on windows over two hours", async () => {
    for (const scopedEnv of [
      canaryEnv(now),
      canaryEnv(now + 120 * 60_000 + 1),
      canaryEnv(now + 60_000, { target: { ...target, ownerId: "user_foreign" } }),
      { ...env, MATRIX_MANAGED_TERMINAL_CONTROL_CANARY_V1: "" },
      { ...env, MATRIX_MANAGED_TERMINAL_CONTROL_CANARY_V1: "{" },
    ]) {
      expect((await request(routes({ env: scopedEnv }), { kind: "computers" }).response).status).toBe(404);
    }
    let clock = now;
    const app = routes({ env: canaryEnv(now + 1000), now: () => clock });
    expect((await request(app, { kind: "computers" }).response).status).toBe(200);
    clock += 1000;
    expect((await request(app, { kind: "computers" }).response).status).toBe(404);
  });

  it("withholds a DEV response that arrives after the canary expires", async () => {
    let clock = now;
    const app = routes({ env: canaryEnv(now + 30_000), now: () => clock });
    const fetcher = vi.fn(async (_url, init) => {
      clock += 30_000;
      return targetReply(init, { available: true, status: "ready", sessions: [] });
    });
    vi.stubGlobal("fetch", fetcher);
    const response = await request(app, { kind: "terminals", targetMachineId: target.machineId }).response;
    expect(fetcher).toHaveBeenCalledOnce();
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "unavailable" });
  });

  it("mints only from the real Web proxy and cancels the same run even before its first tool request", async () => {
    vi.stubEnv("PLATFORM_JWT_SECRET", JWT_SECRET);
    const expiresAt = Date.now() + 30_000;
    const app = createApp({
      db, platformSecret, env: { ...canaryEnv(expiresAt), PLATFORM_JWT_SECRET: JWT_SECRET }, orchestrator: stubOrchestrator(),
    });
    let forwarded: string | null = null;
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
      forwarded = new Headers(init.headers).get(MANAGED_TERMINAL_OWNER_GRANT_HEADER);
      return Response.json({}, { headers: { [MANAGED_TERMINAL_OWNER_GRANT_HEADER]: "credential_not_for_browser" } });
    });
    vi.stubGlobal("fetch", fetcher);
    const browserRequest = async (path: string, body: unknown, human: boolean) => {
      const { token } = await issueSyncJwt({
        secret: JWT_SECRET, clerkUserId: ownerId, handle: "main-computer", runtimeSlot: "primary",
        gatewayUrl: "https://app.matrix-os.com/vm/main-computer", sessionProvenance: human ? "clerk-browser" : "clerk-device",
        ...(human ? { verifiedHumanBrowser: true as const } : {}),
      });
      return app.request(candidate + "/vm/main-computer/~runtime/primary" + path, {
        method: "POST", body: JSON.stringify(body),
        headers: { "x-matrix-edge-secret": edgeSecret, "x-forwarded-host": "app.matrix-os.com", "x-forwarded-proto": "https",
          authorization: "Bearer " + token, "content-type": "application/json",
          [MANAGED_TERMINAL_OWNER_GRANT_HEADER]: "caller_provided_forgery" },
      });
    };
    expect((await browserRequest(turnPath, turn, false)).status).toBe(403);
    expect(forwarded).toBeNull();
    expect((await browserRequest("/api/chats/chat_other/turns", turn, true)).status).toBe(404);
    expect(forwarded).toBeNull();
    const foreignTarget = structuredClone(turn);
    foreignTarget.parts[2]!.resource!.id = managedWorkspaceIdFor("unscoped-computer") + ":" + terminal.tabId;
    expect((await browserRequest(turnPath, foreignTarget, true)).status).toBe(200);
    expect(forwarded).toBeNull();
    const response = await browserRequest(turnPath, turn, true);
    expect(response.status).toBe(200);
    expect(response.headers.has(MANAGED_TERMINAL_OWNER_GRANT_HEADER)).toBe(false);
    expect(forwarded).toMatch(/^[A-Za-z0-9_-]+\.[a-f0-9]{64}$/);
    expect(verifyManagedTerminalOwnerProof(forwarded, { platformSecret })).toMatchObject({ expiresAt, activateBefore: expiresAt });
    const authority = { proof: forwarded!, clientRequestId, bodyDigest };
    expect((await browserRequest("/api/chats/chat_other/runs/run_test/cancel", { clientRequestId: "req_other" }, true)).status).toBe(404);
    expect(await db.executor.selectFrom("managed_terminal_grant_claims").select("run_hash").execute()).toEqual([]);
    const cancel = await browserRequest("/api/chats/chat_test/runs/run_test/cancel", { clientRequestId: "req_stop" }, true);
    expect(cancel.status).toBe(200);
    const denied = await request(app, { ...targetAction, authority }, { issuedAt: Date.now() }).response;
    expect(denied.status).toBe(403);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("re-signs the exact operation for the resolved target without relaying either credential", async () => {
    const targetVerifier = createManagedTerminalVerifier({ direction: "target", now: () => now });
    const targetToken = machineKey(target, "development-computer");
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.redirect).toBe("error");
      const forwarded = new Request("https://203.0.113.21/api/internal/terminal-control", init);
      const body = await forwarded.text();
      expect(targetVerifier(forwarded, targetToken, body)).toBeInstanceOf(AbortSignal);
      expect(forwarded.headers.has("authorization")).toBe(false);
      expect(body).not.toContain(action.runId);
      expect(forwarded.headers.has(MANAGED_TERMINAL_OWNER_GRANT_HEADER)).toBe(false);
      expect(JSON.parse(openManagedTerminalPayload(targetToken, "target", body)!)).toEqual({ source, target, request: targetAction });
      return targetReply(init, { result: { viewport: ["target output"], scrollback: [] } });
    });
    vi.stubGlobal("fetch", fetcher);
    const { response, headers } = request(routes(), action);
    const reply = await response;
    expect(await reply.json()).toEqual({ result: { viewport: ["target output"], scrollback: [] } });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]?.[0]).toBe("https://203.0.113.21:443/api/internal/terminal-control");
    const forwarded = new Headers(fetcher.mock.calls[0]?.[1].headers);
    expect(forwarded.get(MANAGED_TERMINAL_NONCE_HEADER)).toBe(headers.get(MANAGED_TERMINAL_NONCE_HEADER));
    expect(forwarded.get(MANAGED_TERMINAL_TIMESTAMP_HEADER)).toBe(headers.get(MANAGED_TERMINAL_TIMESTAMP_HEADER));
  });

  it("rejects stale epoch, slot, owner, altered requests, replay, and invalid actions before forwarding", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ result: {} }));
    vi.stubGlobal("fetch", fetcher);
    const app = routes();
    const nonce = randomUUID();
    expect((await request(app, action, { machine: { ...source, runtimeSlot: "other-slot" } }).response).status).toBe(401);
    expect((await request(app, action, { machine: { ...source, ownerId: "user_other" } }).response).status).toBe(401);
    expect((await request(app, action, { issuedAt: now - 60_000 }).response).status).toBe(401);
    expect((await request(app, action, { mutate: body => body.replace('"lines":40', '"lines":41') }).response).status).toBe(401);
    expect((await request(app, { ...action, action: { action: "run", argv: ["ls"] } }).response).status).toBe(400);
    await updateUserMachine(db, source.machineId, { runtimeTokenEpoch: 2 });
    expect((await request(app, action).response).status).toBe(401);
    expect(fetcher).not.toHaveBeenCalled();
    const token = machineKey(source, "main-computer", 2);
    const fresh = { ...action, authority: await ownerGrant(2) };
    await request(app, fresh, { token, nonce }).response;
    expect((await request(app, fresh, { token, nonce }).response).status).toBe(401);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("checks the latest target ownership, eligibility and entitlement on every operation", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const app = routes();
    await updateUserMachine(db, target.machineId, { clerkUserId: "user_other", accessClerkUserIds: [ownerId] });
    expect((await request(app, action).response).status).toBe(404);
    await updateUserMachine(db, target.machineId, { clerkUserId: ownerId, accessClerkUserIds: ["user_other"] });
    expect((await request(app, action).response).status).toBe(404);
    await updateUserMachine(db, target.machineId, { accessClerkUserIds: [], deletedAt: new Date(now).toISOString() });
    expect((await request(app, action).response).status).toBe(404);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("requires owner selection even when a caller can sign with the source runtime key", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const app = routes();
    expect((await request(app, targetAction).response).status).toBe(400);
    expect((await request(app, { ...action, authority: { ...action.authority, proof: "a." + "0".repeat(64) } }).response).status).toBe(403);
    expect((await request(app, { ...action, authority: { ...action.authority, clientRequestId: "req_other" } }).response).status).toBe(403);
    expect((await request(app, { ...action, authority: { ...action.authority, bodyDigest: "c".repeat(64) } }).response).status).toBe(403);
    expect((await request(app, { ...action, chatId: "chat_other" }).response).status).toBe(403);
    expect((await request(app, { ...action, revision: "b".repeat(64) }).response).status).toBe(403);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("returns a generic bounded failure without retrying an oversized or unavailable target response", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ result: "a".repeat(MAX_MANAGED_TERMINAL_WIRE_BYTES + 1) })))
      .mockResolvedValueOnce(Response.json({ error: "raw upstream error" }, { status: 504 }));
    vi.stubGlobal("fetch", fetcher);
    const app = routes();
    for (const status of [503, 409]) {
      const response = await request(app, action).response;
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({ error: "unavailable" });
    }
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("returns actual target refusal while rejecting unsigned, replayed, or forged success", async () => {
    let previous: Response | undefined;
    const fetcher = vi.fn()
      .mockImplementationOnce(async (_url, init) => targetReply(init, { error: "user_input_required" }, 409))
      .mockImplementationOnce(async (_url, init) => {
        const signed = targetReply(init, { result: { exitCode: 20 } });
        previous = signed.clone();
        return new Response(JSON.stringify({ result: { exitCode: 0 } }), { headers: signed.headers });
      })
      .mockImplementationOnce(async () => previous)
      .mockResolvedValueOnce(Response.json({ result: { exitCode: 0 } }));
    vi.stubGlobal("fetch", fetcher);
    const app = routes();
    const refusal = await request(app, action).response;
    expect(refusal.status).toBe(409);
    expect(await refusal.json()).toEqual({ error: "user_input_required" });
    for (let index = 0; index < 3; index += 1) {
      const rejected = await request(app, action).response;
      expect(rejected.status).toBe(502);
      expect(await rejected.json()).toEqual({ error: "unavailable" });
    }
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it("keeps owner-only Private Previews isolated from customer Computers and rechecks current eligibility", async () => {
    const preview = { machineId: "managed-preview", ownerId, runtimeSlot: "pv-3793-01234567" };
    const peer = { machineId: "managed-preview-peer", ownerId, runtimeSlot: "pv-3788-01234567" };
    for (const [record, sourcePr] of [[preview, 3793], [peer, 3788]] as const) {
      await insertUserMachine(db, machine({
        ...record, handle: record.runtimeSlot, provisioningClass: "private-preview", sourcePr,
        confirmedBundleVersion: "v2026.11.28-pr" + sourcePr + "-1-1-abcdef0",
      }));
    }
    let authorized = true;
    const eligibility = createPrivatePreviewEligibility({
      internalOrganizationId: "org_preview", now: () => new Date(now), isMember: async () => authorized,
    });
    const app = routes({ privatePreviewEligibility: eligibility });
    const options = { machine: preview, token: machineKey(preview, preview.runtimeSlot) };
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    expect((await request(app, action, options).response).status).toBe(404);
    expect(await (await request(app, { kind: "computers" }, options).response).json()).toEqual({
      computers: [{ machineId: peer.machineId, name: peer.runtimeSlot, runtimeSlot: peer.runtimeSlot }], partial: false,
    });
    const replacing = routes({ privatePreviewEligibility: async runtime => {
      if (runtime.machineId === peer.machineId) {
        await updateUserMachine(db, peer.machineId, { runtimeTokenEpoch: 2 });
      }
      return eligibility(runtime);
    } });
    expect((await request(replacing, { ...action, targetMachineId: peer.machineId }, options).response).status).toBe(404);
    authorized = false;
    expect((await request(app, { kind: "computers" }, options).response).status).toBe(403);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
