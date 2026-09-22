import { Hono } from "hono";
import type { WSContext, WSEvents } from "hono/ws";
import { describe, expect, it, vi } from "vitest";
import { registerMainWebSocketRoutes } from "../../packages/gateway/src/server/main-ws-routes.js";
import { MAX_INFLIGHT_ABORT_CONTROLLERS } from "../../packages/gateway/src/server/main-ws-routes.js";

/**
 * Drive the real main shell socket with a dispatcher that never settles, so
 * every accepted run keeps its abort controller for the whole test.
 */
function mountedSocket() {
  const app = new Hono();
  let events: WSEvents | undefined;
  const upgradeWebSocket = ((createEvents: (context: never) => WSEvents | Promise<WSEvents>) =>
    async (context: never) => {
      events = await createEvents(context);
      return new Response(null, { status: 200 });
    }) as never;
  const dispatch = vi.fn(() => new Promise(() => {}));

  registerMainWebSocketRoutes({
    app,
    upgradeWebSocket,
    syncReport: undefined as never,
    isSyncReportSent: () => true,
    markSyncReportSent: vi.fn(),
    syncPeerRegistry: null as never,
    conversationRuns: { publish: vi.fn(), hasActiveSubscribers: () => false } as never,
    conversationLifecycle: {} as never,
    conversationContextResolver: {} as never,
    reconnectableAbortControllers: new Map(),
    clients: new Set<WSContext>(),
    clientOwnerIds: new WeakMap(),
    conversations: {} as never,
    dispatcher: { dispatch } as never,
    approvalPolicy: { timeout: 1_000 } as never,
    captureGatewayProductEvent: vi.fn(),
    evictOldestMainWsClientIfNeeded: vi.fn(),
    finalizeWithSummary: vi.fn(async () => undefined),
    logUnexpectedJsonParseFailure: vi.fn(),
  });

  const sent: Array<Record<string, unknown>> = [];
  const peer = {
    send: (frame: string) => { sent.push(JSON.parse(frame) as Record<string, unknown>); },
    close: vi.fn(),
    readyState: 1,
  } as unknown as WSContext;

  return { app, dispatch, sent, peer, get events() { return events; } };
}

function submit(socket: ReturnType<typeof mountedSocket>, requestId: string) {
  socket.events?.onMessage?.(
    { data: JSON.stringify({ type: "message", text: "hello", requestId }) } as never,
    socket.peer,
  );
}

describe("main shell WebSocket in-flight run bound", () => {
  it("caps the per-connection abort controllers and rejects further runs", async () => {
    const socket = mountedSocket();
    await socket.app.request("/ws");
    socket.events?.onOpen?.(new Event("open"), socket.peer);

    for (let index = 0; index < MAX_INFLIGHT_ABORT_CONTROLLERS; index += 1) {
      submit(socket, `req_${index}`);
    }
    expect(socket.dispatch).toHaveBeenCalledTimes(MAX_INFLIGHT_ABORT_CONTROLLERS);
    expect(socket.sent.filter((frame) => frame.status === "rejected")).toEqual([]);

    submit(socket, "req_over_cap");

    expect(socket.dispatch).toHaveBeenCalledTimes(MAX_INFLIGHT_ABORT_CONTROLLERS);
    expect(socket.sent).toContainEqual({
      type: "client:ack",
      actionId: "req_over_cap",
      actionType: "message",
      status: "rejected",
      retryable: true,
    });
  });

  it("frees a slot once a run settles", async () => {
    const socket = mountedSocket();
    await socket.app.request("/ws");
    socket.events?.onOpen?.(new Event("open"), socket.peer);
    let settle: (() => void) | undefined;
    socket.dispatch.mockImplementationOnce(() => new Promise<void>((resolve) => { settle = resolve; }));

    for (let index = 0; index < MAX_INFLIGHT_ABORT_CONTROLLERS; index += 1) {
      submit(socket, `req_${index}`);
    }
    settle?.();
    await new Promise((resolve) => setTimeout(resolve, 0));

    submit(socket, "req_after_settle");
    expect(socket.dispatch).toHaveBeenCalledTimes(MAX_INFLIGHT_ABORT_CONTROLLERS + 1);
  });
});
