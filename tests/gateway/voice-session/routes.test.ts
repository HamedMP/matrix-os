import { Hono, type Context } from "hono";
import type { UpgradeWebSocket, WSEvents } from "hono/ws";
import { readFile } from "node:fs/promises";
import { beforeEach, describe, expect, it } from "vitest";
import { CanonicalProviderCatalogSchema } from "@matrix-os/contracts";
import type { VoiceCapability } from "@matrix-os/contracts/voice-session";
import { managedChatInstances } from "../../../packages/gateway/src/chat/managed-chat-catalog.js";
import { validateChatProviderSelection } from "../../../packages/gateway/src/chat/provider-catalog.js";
import { makeAiProviderSnapshot } from "../../fixtures/ai-provider-snapshot.js";
import {
  MissingRequestPrincipalError,
  type RequestPrincipal,
} from "../../../packages/gateway/src/request-principal.js";
import {
  createVoiceSessionRoutes,
  registerVoiceSessionWebSocketRoute,
} from "../../../packages/gateway/src/voice-session/routes.js";
import type { VoiceCanonicalDecision } from "../../../packages/gateway/src/voice-session/ports.js";
import { createVoiceOriginAllowlist } from "../../../packages/gateway/src/voice-session/ticket-auth.js";
import {
  CHAT_ID,
  FakeChatAccess,
  PRINCIPAL,
  makeCreateRequest,
  makeRig,
  resetFrameSeq,
  flush,
  type VoiceTestRig,
} from "./fakes.js";

const CAPABILITY: VoiceCapability = {
  contractVersion: 1,
  status: "available",
  surface: "web_desktop",
  transportModes: ["relayed_websocket"],
  turnModes: ["hands_free", "push_to_talk"],
  supportsInterruption: true,
  resume: "rebuild_only",
  sessionOnly: "enforced",
  actionMode: "conversation_only",
  actionCancellation: "run",
  supportsInputSelection: true,
  supportsOutputSelection: true,
};

/** Server-owned canonical decision matching `makeCreateRequest().selection`:
 * conversation-only speech over an available provider. Session create rides
 * this decision — fixtures that omit it fail closed by design. */
const DECISION: VoiceCanonicalDecision = {
  capability: CAPABILITY,
  selection: { instanceId: "instance-1", model: "claude-sonnet-4" },
  interactionMode: "chat",
  permissionMode: "default",
  executionPolicy: {
    revision: "policy_conversation",
    actionMode: "conversation_only",
    workspaceScope: "apps",
    tools: [],
    delegation: false,
  },
};

function jsonInit(body: unknown, extraHeaders: Record<string, string> = {}) {
  return {
    method: "POST",
    headers: { "content-type": "application/json", ...extraHeaders },
    body: JSON.stringify(body),
  } as const;
}

interface RouteRig {
  app: Hono;
  rig: VoiceTestRig;
  access: FakeChatAccess;
}

function makeRoutes(options: {
  rig?: VoiceTestRig;
  principal?: RequestPrincipal | null | (() => RequestPrincipal);
  denied?: boolean;
  rateLimited?: boolean;
  routeEligibility?: Parameters<typeof createVoiceSessionRoutes>[0]["routeEligibility"];
  canonicalDecision?: Parameters<typeof createVoiceSessionRoutes>[0]["canonicalDecision"];
  capabilities?: Parameters<typeof createVoiceSessionRoutes>[0]["capabilities"];
} = {}): RouteRig {
  const rig = options.rig ?? makeRig();
  const access = new FakeChatAccess();
  access.denied = options.denied ?? false;
  const app = createVoiceSessionRoutes({
    engine: rig.engine,
    resolvePrincipal: () => {
      if (options.principal === null) throw new MissingRequestPrincipalError();
      if (typeof options.principal === "function") return options.principal();
      return options.principal ?? PRINCIPAL;
    },
    chatAccess: access,
    capabilities: options.capabilities ?? { capabilities: () => CAPABILITY },
    canonicalDecision: options.canonicalDecision ?? (() => DECISION),
    ...(options.routeEligibility ? { routeEligibility: options.routeEligibility } : {}),
    ...(options.rateLimited ? { checkRateLimit: () => false } : {}),
  });
  return { app, rig, access };
}

const CREATE_URL = `/api/chats/${CHAT_ID}/voice/sessions`;

async function createViaHttp(app: Hono, overrides: Record<string, unknown> = {}) {
  const res = await app.request(`http://test${CREATE_URL}`, jsonInit({ ...makeCreateRequest(), ...overrides }));
  return { res, body: await res.json() as Record<string, unknown> };
}

describe("voice capabilities route", () => {
  beforeEach(() => resetFrameSeq());

  it("creates native conversation without a task subscription and still fails closed on speech funding", async () => {
    const rig = makeRig();
    Object.assign(rig.adapter.capabilities, { conversationMode: "native_live" });
    const decision = { ...DECISION, selection: undefined };
    const { app } = makeRoutes({ rig, canonicalDecision: () => decision });
    const created = await createViaHttp(app, { selection: undefined });
    expect(created.res.status).toBe(201);
    expect(created.body).toMatchObject({ outcome: "created" });
    const blocked = makeRoutes({ canonicalDecision: () => decision,
      capabilities: { capabilities: () => ({ ...CAPABILITY, status: "unavailable", reason: "provider_unavailable", transportModes: [], turnModes: [] }) } });
    expect((await createViaHttp(blocked.app, { selection: undefined })).res.status).toBe(503);
    expect((await createViaHttp(app, { selection: { instanceId: "client_invented", model: "fake" } })).res.status).toBe(409);
  });

  it("overlaps cold canonical and speech probes for capabilities, create and reconnect", async () => {
    const { vi } = await import("vitest");
    vi.useFakeTimers();
    const { app } = makeRoutes({
      canonicalDecision: async () => { await new Promise(resolve => setTimeout(resolve, 20_600)); return DECISION; },
      capabilities: { capabilities: async () => { await new Promise(resolve => setTimeout(resolve, 9_800)); return CAPABILITY; } },
    });
    try {
      let settled = false;
      const caps = app.request(`http://test/api/chats/${CHAT_ID}/voice/capabilities`).then(response => { settled = true; return response; });
      await vi.advanceTimersByTimeAsync(20_700);
      expect(settled).toBe(true);
      expect((await caps).status).toBe(200);
      settled = false;
      const creation = createViaHttp(app).then(response => { settled = true; return response; });
      await vi.advanceTimersByTimeAsync(20_700);
      expect(settled).toBe(true);
      const created = await creation;
      expect(created.res.status).toBe(201);
      settled = false;
      const reconnect = app.request(`http://test${CREATE_URL}/${created.body.sessionId}/reconnect`, jsonInit({})).then(response => { settled = true; return response; });
      await vi.advanceTimersByTimeAsync(20_700);
      expect(settled).toBe(true);
      expect((await reconnect).status).toBe(200);
      await app.request(`http://test${CREATE_URL}/${created.body.sessionId}`, { method: "DELETE" });
    } finally { vi.useRealTimers(); }
  });

  it("fails readiness closed when canonical authority cannot resolve a selection", async () => {
    const { app } = makeRoutes({ canonicalDecision: () => undefined });
    const response = await app.request(`http://test/api/chats/${CHAT_ID}/voice/capabilities`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "unavailable", reason: "provider_unavailable",
      transportModes: [], turnModes: [] });
  });

  it("composes one authoritative catalog decision per request instead of a duplicate eligibility probe", async () => {
    const source = await readFile(new URL("../../../packages/gateway/src/server/canonical-voice.ts", import.meta.url), "utf8");
    const start = source.indexOf('app.route("/", createVoiceSessionRoutes({');
    const end = source.indexOf("// Aoede standalone assistant bootstrap", start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    expect(source.slice(start, end)).not.toContain("routeEligibility:");
    let decisions = 0;
    const { app } = makeRoutes({ canonicalDecision: () => { decisions += 1; return DECISION; } });
    await app.request(`http://test/api/chats/${CHAT_ID}/voice/capabilities`);
    expect(decisions).toBe(1);
    const created = await createViaHttp(app);
    expect(created.res.status).toBe(201);
    expect(decisions).toBe(2);
    const reconnect = await app.request(`http://test${CREATE_URL}/${created.body.sessionId}/reconnect`, jsonInit({}));
    expect(reconnect.status).toBe(200);
    expect(decisions).toBe(3);
    expect((await app.request(`http://test${CREATE_URL}/${created.body.sessionId}`, { method: "DELETE" })).status).toBe(200);
  });

  it("speech conversation_only does not suppress a qualified canonical tool inventory", async () => {
    const rig = makeRig();
    const request = makeCreateRequest();
    const executionPolicy = { revision: "policy_safe", actionMode: "safe_reads" as const,
      workspaceScope: "workspace", tools: ["workspace_read"], delegation: false };
    let decision = { capability: { ...CAPABILITY, actionMode: "safe_reads" as const },
      selection: request.selection, interactionMode: "canonical_mode", permissionMode: "supervised", executionPolicy };
    const app = createVoiceSessionRoutes({ engine: rig.engine, resolvePrincipal: () => PRINCIPAL,
      chatAccess: new FakeChatAccess(), capabilities: { capabilities: () => CAPABILITY },
      canonicalDecision: () => decision });
    const caps = await app.request(`http://test/api/chats/${CHAT_ID}/voice/capabilities`);
    expect(await caps.json()).toMatchObject({ actionMode: "safe_reads", sessionOnly: "unsupported" });
    const created = await createViaHttp(app);
    expect(created.res.status).toBe(201);
    expect(rig.engine.sessionPolicyLookup.policyForChat(CHAT_ID)).toMatchObject({
      permissionMode: "supervised", executionPolicy,
    });
    decision = { ...decision, executionPolicy: { ...executionPolicy, revision: "changed" } };
    const retry = await createViaHttp(app);
    expect(retry.res.status).toBe(409);
    const reconnect = await app.request(`http://test${CREATE_URL}/${created.body.sessionId}/reconnect`, jsonInit({}));
    expect(reconnect.status).toBe(409);
    expect(rig.engine.describeSession({ principal: PRINCIPAL, chatId: CHAT_ID,
      sessionId: String(created.body.sessionId) })?.status).toBe("ended");
  });

  it("canonical readiness denies create before any adapter/media work", async () => {
    const rig = makeRig();
    const request = makeCreateRequest();
    const app = createVoiceSessionRoutes({ engine: rig.engine, resolvePrincipal: () => PRINCIPAL,
      chatAccess: new FakeChatAccess(), capabilities: { capabilities: () => CAPABILITY },
      canonicalDecision: () => ({ selection: request.selection, interactionMode: "default", permissionMode: "default",
        capability: { ...CAPABILITY, status: "unavailable", reason: "policy_disabled" },
        executionPolicy: { revision: "policy_none", actionMode: "conversation_only", workspaceScope: "workspace", tools: [], delegation: false } }) });
    const created = await createViaHttp(app);
    expect(created.res.status).toBe(503);
    expect(created.body).toEqual({ error: { code: "provider_unavailable", retryable: true, recovery: "retry_connection" } });
    expect(rig.adapter.startCalls).toEqual([]);
    expect(rig.engine.size).toBe(0);
  });

  it("absent canonical qualification never advertises speech-claimed actions or session-only", async () => {
    const rig = makeRig();
    const app = createVoiceSessionRoutes({ engine: rig.engine, resolvePrincipal: () => PRINCIPAL,
      chatAccess: new FakeChatAccess(), capabilities: { capabilities: () => ({ ...CAPABILITY,
        actionMode: "canonical_actions", actionCancellation: "tool" }) } });
    const caps = await app.request(`http://test/api/chats/${CHAT_ID}/voice/capabilities`);
    expect(await caps.json()).toMatchObject({ actionMode: "conversation_only", actionCancellation: "none", sessionOnly: "unsupported" });
  });

  it("returns schema-valid capabilities for an authorized principal", async () => {
    const { app, access } = makeRoutes();
    const res = await app.request(`http://test/api/chats/${CHAT_ID}/voice/capabilities`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("available");
    expect(access.calls).toEqual([{ principalId: "user_1", chatId: CHAT_ID, level: "read" }]);
  });

  it("does not advertise or create voice for the real tool-capable built-in Matrix AI route", async () => {
    const revision = "catalog_matrix_builtin";
    const instances = managedChatInstances(makeAiProviderSnapshot(), []).map((instance) => ({
      ...instance,
      catalogRevision: revision,
    }));
    const catalog = CanonicalProviderCatalogSchema.parse({
      revision,
      drivers: [{
        kind: "kernel",
        displayName: "Claude SDK",
        adapterVersion: "1.0.0",
        capabilityClass: "system_agent",
      }],
      instances,
    });
    const selection = instances[0]!.defaultSelection!;
    const routeEligibility: NonNullable<Parameters<typeof createVoiceSessionRoutes>[0]["routeEligibility"]> =
      ({ selection: requested }) => validateChatProviderSelection({
        catalog,
        selection: requested ?? selection,
        requirements: { voiceConversationOnly: true },
      }).ok;
    const { app, rig } = makeRoutes({ routeEligibility });

    const advertised = await app.request(`http://test/api/chats/${CHAT_ID}/voice/capabilities`);
    expect(advertised.status).toBe(200);
    expect(await advertised.json()).toMatchObject({
      status: "unavailable",
      transportModes: [],
      turnModes: [],
      reason: "provider_unavailable",
    });
    const created = await createViaHttp(app, { selection });
    expect(created.res.status).toBe(422);
    expect(created.body).toEqual({ error: { code: "unsupported_surface", retryable: false, recovery: "continue_in_chat" } });
    expect(rig.engine.size).toBe(0);
  });

  it("rejects malformed chat ids with 400", async () => {
    const { app } = makeRoutes();
    const res = await app.request("http://test/api/chats/bogus!!/voice/capabilities");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: { code: "session_conflict", retryable: false, recovery: "none" } });
  });

  it("returns 401 when the principal resolver fails", async () => {
    const { app } = makeRoutes({ principal: null });
    const res = await app.request(`http://test/api/chats/${CHAT_ID}/voice/capabilities`);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: { code: "permission_denied", retryable: false, recovery: "none" } });
  });

  it("returns 404 when canonical access denies the chat", async () => {
    const { app } = makeRoutes({ denied: true });
    const res = await app.request(`http://test/api/chats/${CHAT_ID}/voice/capabilities`);
    expect(res.status).toBe(404);
  });

  it("returns 429 when the rate limit hook denies", async () => {
    const { app } = makeRoutes({ rateLimited: true });
    const res = await app.request(`http://test/api/chats/${CHAT_ID}/voice/capabilities`);
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: { code: "session_limit_reached", retryable: true, recovery: "retry_connection" } });
  });
});

describe("voice session create route", () => {
  beforeEach(() => resetFrameSeq());

  it("creates a session and returns transport credentials once", async () => {
    const { app } = makeRoutes();
    const { res, body } = await createViaHttp(app);
    expect(res.status).toBe(201);
    expect(body.outcome).toBe("created");
    expect(body.status).toBe("connecting");
    const transport = body.transport as Record<string, unknown>;
    expect(transport.kind).toBe("relayed_websocket");
    expect(String(transport.ticket)).toMatch(/^vt_/);
    expect(String(transport.url)).toBe(`/ws/chats/${CHAT_ID}/voice/${String(body.sessionId)}`);
  });

  it("validates the body strictly", async () => {
    const { app } = makeRoutes();
    const bad = await app.request(`http://test${CREATE_URL}`, jsonInit({ clientRequestId: "x" }));
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: { code: "session_conflict", retryable: false, recovery: "none" } });
    const extra = await app.request(`http://test${CREATE_URL}`, jsonInit({ ...makeCreateRequest(), smuggle: true }));
    expect(extra.status).toBe(400);
  });

  it("enforces the body limit", async () => {
    const { app } = makeRoutes();
    const big = { ...makeCreateRequest(), clientRequestId: `req_${"a".repeat(5_000)}` };
    const res = await app.request(`http://test${CREATE_URL}`, jsonInit(big));
    // Oversize clientRequestId fails schema OR the body limit fires first;
    // a 413 takes precedence by design for true payload flooding.
    expect([400, 413]).toContain(res.status);
  });

  it("rotates an unconsumed lease on identical retry", async () => {
    const { app } = makeRoutes();
    const first = await createViaHttp(app);
    const second = await createViaHttp(app);
    expect(second.res.status).toBe(200);
    expect(second.body.outcome).toBe("rotated_unconsumed");
    const t1 = (first.body.transport as Record<string, unknown>).ticket;
    const t2 = (second.body.transport as Record<string, unknown>).ticket;
    expect(t2).not.toBe(t1);
  });

  it("returns status-only for consumed leases — no credentials serialize", async () => {
    const { app, rig } = makeRoutes();
    const first = await createViaHttp(app);
    const transport = first.body.transport as Record<string, unknown>;
    // Consume the ticket exactly as the WS path would.
    rig.tickets.consume(String(transport.ticket), {
      path: String(transport.url),
      sessionId: String(first.body.sessionId),
      chatId: CHAT_ID,
    });
    const retry = await createViaHttp(app);
    expect(retry.res.status).toBe(200);
    expect(retry.body.outcome).toBe("existing_consumed");
    expect(retry.body.reconnectRequired).toBe(true);
    // Contract-asserted: no credential material may serialize.
    expect("transport" in retry.body).toBe(false);
    expect("ticket" in retry.body).toBe(false);
    expect("ephemeralCredential" in retry.body).toBe(false);
    expect(JSON.stringify(retry.body)).not.toContain("vt_");
  });

  it("rejects identical clientRequestId with diverging semantics", async () => {
    const { app } = makeRoutes();
    await createViaHttp(app);
    const conflict = await createViaHttp(app, { turnMode: "push_to_talk" });
    expect(conflict.res.status).toBe(409);
    expect(conflict.body).toEqual({ error: { code: "session_conflict", retryable: false, recovery: "start_new_session" } });
  });

  it("rejects a second active session for the same chat", async () => {
    const { app } = makeRoutes();
    await createViaHttp(app);
    const conflict = await createViaHttp(app, { clientRequestId: "req-other" });
    expect(conflict.res.status).toBe(409);
    expect(conflict.body).toEqual({ error: { code: "session_conflict", retryable: false, recovery: "start_new_session" } });
  });
});

describe("voice session delete route", () => {
  beforeEach(() => resetFrameSeq());

  it("cleanup bypasses create admission exhaustion and remains bounded after exact owner/session checks", async () => {
    const rig = makeRig();
    const access = new FakeChatAccess();
    const app = createVoiceSessionRoutes({ engine: rig.engine, resolvePrincipal: () => PRINCIPAL,
      chatAccess: access, capabilities: { capabilities: () => CAPABILITY }, checkRateLimit: () => false });
    const created = rig.engine.createSession({ principal: PRINCIPAL, chatId: CHAT_ID, request: makeCreateRequest() });
    access.denied = true; // deleted/revoked Chat must not strand owned media cleanup
    const url = `http://test${CREATE_URL}/${created.session.sessionId}`;
    const ended = await app.request(url, { method: "DELETE" });
    expect(ended.status).toBe(200);
    expect((await ended.json()).ended).toBe(true);
    for (let i = 0; i < 11; i++) expect((await app.request(url, { method: "DELETE" })).status).toBe(200);
    const capped = await app.request(url, { method: "DELETE" });
    expect(capped.status).toBe(429);
    expect(await capped.json()).toEqual({ error: { code: "session_limit_reached", retryable: true, recovery: "retry_connection" } });
  });

  it("reconnect access loss stops the exact owned session before returning unavailable", async () => {
    const { app, rig, access } = makeRoutes();
    const created = await createViaHttp(app);
    access.denied = true;
    const res = await app.request(`http://test${CREATE_URL}/${created.body.sessionId}/reconnect`, jsonInit({}));
    expect(res.status).toBe(404);
    expect(rig.engine.describeSession({ principal: PRINCIPAL, chatId: CHAT_ID, sessionId: String(created.body.sessionId) })?.status).toBe("ended");
  });

  it("ends the session idempotently", async () => {
    const { app } = makeRoutes();
    const created = await createViaHttp(app);
    const url = `http://test${CREATE_URL}/${String(created.body.sessionId)}`;
    const first = await app.request(url, { method: "DELETE" });
    expect(first.status).toBe(200);
    const firstBody = await first.json();
    expect(firstBody).toMatchObject({ ended: true, alreadyTerminal: false, status: "ended" });
    const second = await app.request(url, { method: "DELETE" });
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ ended: true, alreadyTerminal: true });
  });

  it("returns 404 for unknown and foreign sessions", async () => {
    const { app, rig } = makeRoutes();
    const res = await app.request(`http://test${CREATE_URL}/vs_unknown`, { method: "DELETE" });
    expect(res.status).toBe(404);
    // A foreign principal on the same rig cannot see the session at all.
    const created = await createViaHttp(app);
    expect(created.res.status).toBe(201);
    const foreign = createVoiceSessionRoutes({
      engine: rig.engine,
      resolvePrincipal: () => ({ userId: "user_2", source: "jwt" }),
      chatAccess: new FakeChatAccess(),
      capabilities: { capabilities: () => CAPABILITY },
    });
    const foreignRes = await foreign.request(
      `http://test${CREATE_URL}/${String(created.body.sessionId)}`,
      { method: "DELETE" },
    );
    expect(foreignRes.status).toBe(404);
  });

  it("applies bodyLimit to DELETE", async () => {
    const { app } = makeRoutes();
    const created = await createViaHttp(app);
    const res = await app.request(`http://test${CREATE_URL}/${String(created.body.sessionId)}`, {
      method: "DELETE",
      headers: { "content-type": "application/json", "content-length": String(8 * 1024) },
      body: "x".repeat(8 * 1024),
    });
    expect(res.status).toBe(413);
  });
});

describe("voice session reconnect route", () => {
  beforeEach(() => resetFrameSeq());

  it("rotates ticket + epoch and preserves the session", async () => {
    const { app } = makeRoutes();
    const created = await createViaHttp(app);
    const res = await app.request(
      `http://test${CREATE_URL}/${String(created.body.sessionId)}/reconnect`,
      jsonInit({}),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toMatchObject({
      sessionId: created.body.sessionId,
      chatId: CHAT_ID,
      limits: created.body.limits,
    });
    expect(Object.keys(body).sort()).toEqual(["chatId", "limits", "sessionId", "transport"]);
    const transport = body.transport as Record<string, unknown>;
    expect(String(transport.ticket)).toMatch(/^vt_/);
    expect(transport.epoch).toBe(2);
    const original = (created.body.transport as Record<string, unknown>).ticket;
    expect(transport.ticket).not.toBe(original);
  });

  it("tolerates an empty body but rejects malformed JSON", async () => {
    const { app } = makeRoutes();
    const created = await createViaHttp(app);
    const url = `http://test${CREATE_URL}/${String(created.body.sessionId)}/reconnect`;
    const empty = await app.request(url, { method: "POST" });
    expect(empty.status).toBe(200);
    const bad = await app.request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{oops",
    });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: { code: "session_conflict", retryable: false, recovery: "none" } });
  });

  it("returns 404 for unknown sessions and 409 for ended sessions", async () => {
    const { app } = makeRoutes();
    const missing = await app.request(`http://test${CREATE_URL}/vs_missing/reconnect`, jsonInit({}));
    expect(missing.status).toBe(404);
    const created = await createViaHttp(app);
    await app.request(`http://test${CREATE_URL}/${String(created.body.sessionId)}`, { method: "DELETE" });
    const ended = await app.request(`http://test${CREATE_URL}/${String(created.body.sessionId)}/reconnect`, jsonInit({}));
    expect(ended.status).toBe(409);
    expect(await ended.json()).toEqual({ error: { code: "session_conflict", retryable: false, recovery: "start_new_session" } });
  });

  it("keeps the session alive when re-verification hits a transient failure", async () => {
    // A capability outage is retryable — it must not destroy a session the
    // client can still reconnect into once the dependency recovers.
    let failCapabilities = false;
    const rig = makeRig();
    const app = createVoiceSessionRoutes({
      engine: rig.engine,
      resolvePrincipal: () => PRINCIPAL,
      chatAccess: new FakeChatAccess(),
      capabilities: {
        capabilities: () => failCapabilities
          ? Promise.reject(new Error("store blip"))
          : Promise.resolve(CAPABILITY),
      },
      canonicalDecision: () => DECISION,
    });
    const created = await createViaHttp(app);
    const sessionId = String(created.body.sessionId);
    failCapabilities = true;
    const res = await app.request(`http://test${CREATE_URL}/${sessionId}/reconnect`, jsonInit({}));
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(rig.engine.describeSession({ principal: PRINCIPAL, chatId: CHAT_ID, sessionId })?.status)
      .not.toBe("ended");
    // And the retry succeeds once the dependency recovers.
    failCapabilities = false;
    const retry = await app.request(`http://test${CREATE_URL}/${sessionId}/reconnect`, jsonInit({}));
    expect(retry.status).toBe(200);
  });
});

describe("voice websocket upgrade", () => {
  let rig: VoiceTestRig;
  let app: Hono;
  let upgradeEvents: WSEvents[];
  const sent: unknown[] = [];
  let closed: { code: number; reason: string } | null;

  const fakeWs = {
    send(data: string | ArrayBuffer) {
      sent.push(typeof data === "string" ? JSON.parse(data) : data);
    },
    close(code?: number, reason?: string) {
      closed = { code: code ?? 1000, reason: reason ?? "" };
    },
    raw: { bufferedAmount: 0 },
  };

  function lastSent(type: string): Record<string, unknown> | undefined {
    const frames = sent.filter((f): f is Record<string, unknown> => (f as { type?: string }).type === type);
    return frames[frames.length - 1];
  }

  beforeEach(() => {
    resetFrameSeq();
    rig = makeRig();
    upgradeEvents = [];
    sent.length = 0;
    closed = null;
    app = createVoiceSessionRoutes({
      engine: rig.engine,
      resolvePrincipal: () => PRINCIPAL,
      chatAccess: new FakeChatAccess(),
      capabilities: { capabilities: () => CAPABILITY },
      canonicalDecision: () => DECISION,
    });
    const fakeUpgrade = ((createEvents: (c: Context) => WSEvents) => {
      return async (c: Context) => {
        upgradeEvents.push(createEvents(c));
        return c.text("upgrade-planned");
      };
    }) as unknown as UpgradeWebSocket;
    registerVoiceSessionWebSocketRoute({
      app,
      upgradeWebSocket: fakeUpgrade,
      engine: rig.engine,
      tickets: rig.tickets,
      isOriginAllowed: createVoiceOriginAllowlist(["https://app.example.com"]),
    });
  });

  async function planUpgrade(query = "") {
    const created = await createViaHttp(app);
    const transport = created.body.transport as Record<string, unknown>;
    const url = String(transport.url) + (query || `?ticket=${String(transport.ticket)}`);
    const res = await app.request(`http://test${url}`, { headers: { origin: "https://app.example.com" } });
    expect(res.status).toBe(200);
    expect(upgradeEvents).toHaveLength(1);
    return { events: upgradeEvents[0]!, transport, sessionId: String(created.body.sessionId) };
  }

  it("verifies + consumes the ticket and emits session.state on open", async () => {
    const { events } = await planUpgrade();
    events.onOpen?.({} as never, fakeWs as never);
    expect(closed).toBeNull();
    expect(lastSent("session.state")).toMatchObject({ type: "session.state", state: "connecting" });
  });

  it("rejects unknown and replayed tickets before mutation", async () => {
    const first = await planUpgrade();
    first.events.onOpen?.({} as never, fakeWs as never);
    expect(lastSent("session.state")).toBeTruthy();
    // Replay the same ticket through a fresh upgrade.
    sent.length = 0;
    const res = await app.request(`http://test${String(first.transport.url)}?ticket=${String(first.transport.ticket)}`, { headers: { origin: "https://app.example.com" } });
    expect(res.status).toBe(200);
    upgradeEvents[1]!.onOpen?.({} as never, fakeWs as never);
    expect(closed?.code).toBe(1008);
    expect(lastSent("session.state")).toBeUndefined();
  });

  it("rejects disallowed origins", async () => {
    const created = await createViaHttp(app);
    const transport = created.body.transport as Record<string, unknown>;
    const res = await app.request(`http://test${String(transport.url)}?ticket=${String(transport.ticket)}`, {
      headers: { origin: "https://evil.example.com" },
    });
    expect(res.status).toBe(200);
    upgradeEvents[0]!.onOpen?.({} as never, fakeWs as never);
    expect(closed?.code).toBe(1008);
    // Ticket survives origin denial: origin is checked BEFORE consume.
    expect(rig.tickets.describeSession(String(created.body.sessionId))?.state).toBe("minted");
  });

  it("rejects upgrade requests with extra query params", async () => {
    const { events } = await planUpgrade("?ticket=vt_" + "a".repeat(43) + "&other=1");
    expect(() => events.onOpen?.({} as never, fakeWs as never)).not.toThrow();
    expect(closed?.code).toBe(1008);
  });

  it("rejects an upgrade with no ticket parameter at all", async () => {
    const created = await createViaHttp(app);
    const transport = created.body.transport as Record<string, unknown>;
    await app.request(`http://test${String(transport.url)}`, { headers: { origin: "https://app.example.com" } });
    upgradeEvents[0]!.onOpen?.({} as never, fakeWs as never);
    expect(closed?.code).toBe(1008);
    // The unclaimed ticket stays minted — rejection precedes consumption.
    expect(rig.tickets.describeSession(String(created.body.sessionId))?.state).toBe("minted");
  });

  it("rejects an upgrade whose ticket parameter exceeds the bound", async () => {
    const { events } = await planUpgrade(`?ticket=vt_${"a".repeat(300)}`);
    events.onOpen?.({} as never, fakeWs as never);
    expect(closed?.code).toBe(1008);
  });

  it("rejects duplicate ticket parameters — exactly one is required", async () => {
    const created = await createViaHttp(app);
    const transport = created.body.transport as Record<string, unknown>;
    const url = `${String(transport.url)}?ticket=${String(transport.ticket)}&ticket=${String(transport.ticket)}`;
    await app.request(`http://test${url}`, { headers: { origin: "https://app.example.com" } });
    upgradeEvents[0]!.onOpen?.({} as never, fakeWs as never);
    expect(closed?.code).toBe(1008);
    // Rejection precedes consumption: the ticket survives for a clean retry.
    expect(rig.tickets.describeSession(String(created.body.sessionId))?.state).toBe("minted");
  });

  it("accepts a validated client frame and rejects malformed frames", async () => {
    const { events, sessionId } = await planUpgrade();
    events.onOpen?.({} as never, fakeWs as never);
    const onMessage = events.onMessage!;
    // client.ready -> listening
    onMessage({ data: JSON.stringify({
      contractVersion: 1, sessionId, epoch: 1, sequence: 1,
      type: "client.ready",
      audio: { codec: "pcm_s16le", sampleRateHz: 16_000, channels: 1, frameDurationMs: 20 },
      capabilities: { formats: [{ codec: "pcm_s16le", sampleRateHz: 16_000, channels: 1, frameDurationMs: 20 }], binaryAudio: false, maxAudioFrameBytes: 65_536, deviceChangeEvents: false },
    }) }, fakeWs as never);
    await flush(rig, sessionId);
    expect(lastSent("session.state")).toMatchObject({ state: "listening" });
    // Malformed JSON closes the socket.
    onMessage({ data: "{broken" }, fakeWs as never);
    expect(closed?.code).toBe(1008);
  });

  it("rejects frames failing contract validation", async () => {
    const { events, sessionId } = await planUpgrade();
    events.onOpen?.({} as never, fakeWs as never);
    events.onMessage?.({ data: JSON.stringify({
      contractVersion: 1, sessionId, epoch: 1, sequence: 1, type: "nonsense.frame",
    }) }, fakeWs as never);
    expect(closed?.code).toBe(1008);
  });

  it("onClose detaches the transport into reconnecting", async () => {
    const { events, sessionId } = await planUpgrade();
    events.onOpen?.({} as never, fakeWs as never);
    events.onMessage?.({ data: JSON.stringify({
      contractVersion: 1, sessionId, epoch: 1, sequence: 1,
      type: "client.ready",
      audio: { codec: "pcm_s16le", sampleRateHz: 16_000, channels: 1, frameDurationMs: 20 },
      capabilities: { formats: [{ codec: "pcm_s16le", sampleRateHz: 16_000, channels: 1, frameDurationMs: 20 }], binaryAudio: false, maxAudioFrameBytes: 65_536, deviceChangeEvents: false },
    }) }, fakeWs as never);
    await flush(rig, sessionId);
    events.onClose?.({} as never, fakeWs as never);
    expect(rig.engine.describeSession({ principal: PRINCIPAL, chatId: CHAT_ID, sessionId })?.status).toBe("reconnecting");
  });
});
