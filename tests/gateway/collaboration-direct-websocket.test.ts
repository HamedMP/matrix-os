/**
 * Issue #1829 / spec 535 FR-027: the direct terminal WebSocket is always mounted.
 * A home whose shared-terminal dependency is missing admits the caller exactly as
 * the HTTP terminal routes do and then answers a generic, retryable unavailable;
 * it never falls through to a not-found that reads as "not shared" or "access removed".
 */
import { Hono, type Context } from "hono";
import type { UpgradeWebSocket, WSEvents } from "hono/ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { COLLABORATION_DIRECT_PROTOCOL_VERSION, CollaborationTerminalFrameSchema } from "@matrix-os/contracts";
import { DirectAuthError } from "../../packages/gateway/src/collaboration/direct-auth.js";
import { registerCollaborationDirectWebSocketRoutes } from "../../packages/gateway/src/collaboration/direct-websocket.js";

const scopeId = "10000000-0000-4000-8000-000000000001";
const sessionId = "20000000-0000-4000-8000-000000000002";
const nonce = "a".repeat(32);
const terminalPath = `/ws/collaboration/direct/scopes/${scopeId}/terminal`;

type FakeWs = { send: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>; raw: { bufferedAmount: number } };

function harness(options: { verifyTicket?: () => unknown; openStream?: () => Promise<unknown>; evidenceExpiresAt?: string; terminal?: boolean } = {}) {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const commitAdmission = vi.fn();
  const release = vi.fn();
  const verifier = {
    verifyTicket: vi.fn(options.verifyTicket ?? ((value: unknown) => value)),
  };
  const sessions = {
    openStream: vi.fn(options.openStream ?? (async () => ({
      session: { id: sessionId, actorId: "user_member" },
      context: { authorityGeneration: 3 },
      commitAdmission,
      release,
    }))),
    subscribeEnded: vi.fn(() => () => undefined),
    describe: vi.fn(() => options.evidenceExpiresAt ? {
      authorityGeneration: 3, evidenceExpiresAt: options.evidenceExpiresAt,
      expiresAt: new Date(Date.parse(options.evidenceExpiresAt) + 280_000).toISOString(),
    } : null),
    runStreamInput: vi.fn(),
  };
  const events = { open: vi.fn(async () => ({ close: vi.fn(), touch: vi.fn() })) };
  const terminal = options.terminal ? {
    dispatcher: {}, registry: { open: vi.fn(async () => ({ close: vi.fn(), touch: vi.fn() })) },
    control: { markDisconnected: vi.fn() },
  } : undefined;
  let socketEvents: WSEvents<unknown> | undefined;
  const upgradeWebSocket = ((factory: (context: Context) => WSEvents<unknown>) => (
    async (context: Context) => {
      socketEvents = factory(context);
      return context.text("upgrade captured");
    }
  )) as unknown as UpgradeWebSocket;
  const app = new Hono();
  registerCollaborationDirectWebSocketRoutes({
    app,
    upgradeWebSocket,
    verifier: verifier as never,
    sessions: sessions as never,
    authority: {} as never,
    events: events as never,
    ...(terminal ? { terminal: terminal as never } : {}),
  });
  return { app, warn, verifier, sessions, events, commitAdmission, release, socket: () => socketEvents! };
}

function ticketQuery(purpose: "events" | "terminal" = "terminal"): string {
  const ticket = { purpose, resource: { scopeId, kind: purpose === "events" ? "chat" : "terminal" }, nonce };
  return `ticket=${Buffer.from(JSON.stringify(ticket)).toString("base64url")}`;
}

function handshake(): string {
  return JSON.stringify({
    protocolVersion: COLLABORATION_DIRECT_PROTOCOL_VERSION,
    type: "handshake",
    sessionId,
    ticketNonce: nonce,
    possession: "p".repeat(86),
  });
}

function frames(ws: FakeWs): Array<Record<string, unknown>> {
  return ws.send.mock.calls.map(([raw]) => JSON.parse(String(raw)) as Record<string, unknown>);
}

describe("direct terminal WebSocket without the shared terminal dependency", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("mounts the terminal socket and answers a retryable unavailable after admission, never a not-found", async () => {
    const { app, warn, sessions, events, commitAdmission, release, socket } = harness();
    const response = await app.request(`${terminalPath}?${ticketQuery()}`);
    expect(response.status).not.toBe(404);
    expect(await response.text()).toBe("upgrade captured");

    const ws: FakeWs = { send: vi.fn(), close: vi.fn(), raw: { bufferedAmount: 0 } };
    socket().onOpen?.({} as never, ws as never);
    expect(ws.send).not.toHaveBeenCalled();
    socket().onMessage?.({ data: handshake() } as never, ws as never);

    await vi.waitFor(() => expect(ws.close).toHaveBeenCalledWith(1013, "Unavailable"));
    expect(ws.close).toHaveBeenCalledOnce();
    // Admission ran first (ticket, possession, authority), exactly like the HTTP routes.
    expect(sessions.openStream).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    expect(commitAdmission).not.toHaveBeenCalled();
    expect(events.open).not.toHaveBeenCalled();
    const sent = frames(ws);
    expect(sent).toHaveLength(1);
    expect(CollaborationTerminalFrameSchema.parse(sent[0])).toMatchObject({
      type: "terminal.unavailable",
      scopeId,
      authorityGeneration: "3",
      code: "unavailable",
    });
    expect(warn).toHaveBeenCalledWith("[collaboration-direct-ws:terminal] shared terminal dependency missing");

    socket().onClose?.({} as never, ws as never);
    expect(release).toHaveBeenCalledOnce();
  });

  it("keeps the unavailable answer behind the ticket: an unverified caller gets the generic denial", async () => {
    const { app, sessions, socket } = harness({
      verifyTicket: () => { throw new DirectAuthError("invalid_ticket", "Connection ticket is invalid"); },
    });
    await app.request(`${terminalPath}?${ticketQuery()}`);
    const ws: FakeWs = { send: vi.fn(), close: vi.fn(), raw: { bufferedAmount: 0 } };
    socket().onOpen?.({} as never, ws as never);
    expect(ws.close).toHaveBeenCalledWith(1008, "Unavailable");
    expect(frames(ws)).toEqual([{ version: 1, type: "collaboration.error", code: "unavailable" }]);
    expect(sessions.openStream).not.toHaveBeenCalled();
  });

  it("keeps the unavailable answer behind admission: a denied session is refused as before", async () => {
    const { app, release, socket } = harness({
      openStream: async () => { throw new DirectAuthError("denied", "Stream access is unavailable"); },
    });
    await app.request(`${terminalPath}?${ticketQuery()}`);
    const ws: FakeWs = { send: vi.fn(), close: vi.fn(), raw: { bufferedAmount: 0 } };
    socket().onOpen?.({} as never, ws as never);
    socket().onMessage?.({ data: handshake() } as never, ws as never);
    await vi.waitFor(() => expect(ws.close).toHaveBeenCalledWith(1008, "Invalid frame"));
    expect(frames(ws)).toEqual([{ version: 1, type: "collaboration.error", code: "unavailable" }]);
    expect(release).not.toHaveBeenCalled();
  });
});

describe("machine-free member direct stream evidence lease", () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it.each(["events", "terminal"] as const)("closes an idle %s stream within 25 seconds of membership evidence expiry", async (purpose) => {
    const started = new Date("2026-09-28T09:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(started);
    const evidenceExpiresAt = new Date(started.getTime() + 20_000).toISOString();
    const { app, sessions, commitAdmission, socket } = harness({ evidenceExpiresAt, terminal: purpose === "terminal" });
    const path = `/ws/collaboration/direct/scopes/${scopeId}/${purpose}`;
    await app.request(`${path}?${ticketQuery(purpose)}`);
    const ws: FakeWs = { send: vi.fn(), close: vi.fn(), raw: { bufferedAmount: 0 } };
    socket().onOpen?.({} as never, ws as never);
    socket().onMessage?.({ data: handshake() } as never, ws as never);
    await vi.advanceTimersByTimeAsync(1);
    expect(commitAdmission).toHaveBeenCalledOnce();
    expect(sessions.describe).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(25_000);
    expect(ws.close).toHaveBeenCalledWith(1008, "Lease expired");
  });
});
