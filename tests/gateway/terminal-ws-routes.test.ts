import { Hono } from "hono";
import type { UpgradeWebSocket, WSEvents, WSContext } from "hono/ws";
import { describe, expect, it, vi } from "vitest";
import { registerTerminalWebSocketRoutes } from "../../packages/gateway/src/server/terminal-ws-routes.js";

function mountedRoutes() {
  const app = new Hono();
  let events: WSEvents | undefined;
  const upgradeWebSocket = ((createEvents: (context: never) => WSEvents | Promise<WSEvents>) =>
    async (context: never) => {
      events = await createEvents(context);
      return new Response(null, { status: 200 });
    }) as UpgradeWebSocket;
  const getPrincipal = vi.fn(() => { throw new Error("Principal unavailable"); });
  const attach = vi.fn();
  const attachOwnership = vi.fn();

  registerTerminalWebSocketRoutes({
    app,
    upgradeWebSocket,
    homePath: "/tmp/terminal-ws-route-test",
    terminalWorkspaceRuntime: { attach } as never,
    terminalLiveOwnership: { attach: attachOwnership } as never,
    workspaceSessionRuntimeBridge: {} as never,
    terminalRuntimeOwnerIds: [],
    chatRepository: null,
    terminalWorkspaceProjectAdmission: {} as never,
    captureTerminalEvent: vi.fn(),
    getPrincipal,
  });

  const socket = () => {
    const sent: string[] = [];
    const close = vi.fn();
    return { sent, close, context: { send: (frame: string) => sent.push(frame), close } as unknown as WSContext };
  };
  return { app, socket, get events() { return events; }, getPrincipal, attach, attachOwnership };
}

describe("terminal WebSocket route registration", () => {
  it("keeps the tab route mounted and returns upgrade-required on retired paths", async () => {
    const routes = mountedRoutes();
    for (const path of ["/ws/terminal/session", "/ws/terminal"]) {
      const response = await routes.app.request(path);
      expect(response.status).toBe(426);
      expect(await response.json()).toEqual({
        error: "client_upgrade_required",
        message: "Upgrade Matrix OS to use terminal workspaces.",
      });
    }
    const response = await routes.app.request("/ws/terminal/tab?client=browser");
    expect(response.status).toBe(200);
    expect(routes.events?.onOpen).toBeTypeOf("function");
  });

  it("rejects an invalid tab query before principal, ownership or runtime access", async () => {
    const routes = mountedRoutes();
    await routes.app.request("/ws/terminal/tab?client=browser");
    const peer = routes.socket();
    routes.events?.onOpen?.(new Event("open"), peer.context);

    expect(peer.sent).toEqual([JSON.stringify({ type: "error", code: "invalid_request", message: "Invalid request" })]);
    expect(peer.close).toHaveBeenCalledOnce();
    expect(routes.getPrincipal).not.toHaveBeenCalled();
    expect(routes.attachOwnership).not.toHaveBeenCalled();
    expect(routes.attach).not.toHaveBeenCalled();
  });

  it("denies an unauthenticated valid tab before claiming the lease or attaching", async () => {
    const routes = mountedRoutes();
    await routes.app.request(
      "/ws/terminal/tab?workspaceId=tws_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&tabId=tt_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb&client=browser",
    );
    const peer = routes.socket();
    routes.events?.onOpen?.(new Event("open"), peer.context);

    await vi.waitFor(() => expect(peer.close).toHaveBeenCalledOnce());
    expect(routes.getPrincipal).toHaveBeenCalledOnce();
    expect(routes.attachOwnership).not.toHaveBeenCalled();
    expect(routes.attach).not.toHaveBeenCalled();
    expect(peer.sent).toEqual([JSON.stringify({ type: "error", code: "attach_failed", message: "Shell attach failed" })]);
  });
});
