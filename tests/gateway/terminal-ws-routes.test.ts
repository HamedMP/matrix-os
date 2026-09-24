import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import type { UpgradeWebSocket, WSEvents, WSContext } from "hono/ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerTerminalWebSocketRoutes } from "../../packages/gateway/src/server/terminal-ws-routes.js";
import { createShellClient } from "../../packages/sync-client/src/cli/shell-client.js";

const WORKSPACE_ID = "tws_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TAB_ID = "tt_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const TERMINAL_REF = { workspaceId: WORKSPACE_ID, tabId: TAB_ID };
const REF_KEY = `${WORKSPACE_ID}:${TAB_ID}`;
const OWNER_ID = "user_terminal_owner";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

/**
 * Mount the real route against injected dependencies so authorization order is
 * observed through the calls the route makes, not through the source text.
 */
interface RepositoryDouble {
  getTerminalBinding: ReturnType<typeof vi.fn>;
  listBoundTerminalSessionIds: ReturnType<typeof vi.fn>;
}

function authorizedRoutes(input: {
  accessScope: "owner" | "chat" | "shared";
  repository?: (order: string[]) => RepositoryDouble;
}) {
  const app = new Hono();
  const order: string[] = [];
  let events: WSEvents | undefined;
  const upgradeWebSocket = ((createEvents: (context: never) => WSEvents | Promise<WSEvents>) =>
    async (context: never) => {
      events = await createEvents(context);
      return new Response(null, { status: 200 });
    }) as UpgradeWebSocket;

  const send = vi.fn((frame: { type: string }) => { order.push(`runtime-send:${frame.type}`); });
  const attach = vi.fn(async (_input: { onFrame: (frame: unknown) => void }) => {
    order.push("attach");
    return { send, close: vi.fn() };
  });
  const listWorkspaces = vi.fn(async () => [{
    id: WORKSPACE_ID,
    tabs: [{ id: TAB_ID, accessScope: input.accessScope }],
  }]);
  const withWorkspace = vi.fn(async (
    _ownerId: string,
    _workspaceId: string,
    action: string,
    run: () => Promise<unknown>,
  ) => {
    order.push(`admission:${action}`);
    return run();
  });
  const chatRepository = input.repository ? input.repository(order) : null;
  const homePath = mkdtempSync(join(tmpdir(), "terminal-ws-routes-"));
  homes.push(homePath);

  registerTerminalWebSocketRoutes({
    app,
    upgradeWebSocket,
    homePath,
    terminalWorkspaceRuntime: { attach, listWorkspaces } as never,
    terminalLiveOwnership: {
      attach: vi.fn(),
      detach: vi.fn(),
      touch: vi.fn(),
      role: vi.fn(() => "writer"),
      leaseEpoch: vi.fn(() => 1),
      allowsMutation: vi.fn(() => true),
    } as never,
    workspaceSessionRuntimeBridge: { consumeSessionAttachment: vi.fn() } as never,
    terminalRuntimeOwnerIds: [OWNER_ID],
    chatRepository: chatRepository as never,
    terminalWorkspaceProjectAdmission: { withWorkspace } as never,
    captureTerminalEvent: vi.fn(),
    getPrincipal: vi.fn(() => ({ userId: OWNER_ID, source: "jwt" as const })),
    logBestEffortFailure: vi.fn(),
    logUnexpectedJsonParseFailure: vi.fn(),
    logUnexpectedWsSendFailure: vi.fn(),
  });

  const socket = () => {
    const sent: string[] = [];
    const close = vi.fn();
    return { sent, close, context: { send: (frame: string) => sent.push(frame), close } as unknown as WSContext };
  };
  return { app, socket, order, attach, withWorkspace, send, chatRepository, get events() { return events; } };
}

function repositoryDouble(bound: boolean) {
  return (order: string[]): RepositoryDouble => ({
    getTerminalBinding: vi.fn(async () => {
      order.push("binding");
      return bound ? { sessionCreatedAt: "2026-08-28T10:00:00.000Z" } : null;
    }),
    listBoundTerminalSessionIds: vi.fn(async (_owner: unknown, ids: readonly string[]) => {
      order.push("bound-lookup");
      return bound ? ids.filter((id) => id === REF_KEY) : [];
    }),
  });
}

async function openTab(routes: ReturnType<typeof authorizedRoutes>, query: string, client = "browser") {
  await routes.app.request(`/ws/terminal/tab?workspaceId=${WORKSPACE_ID}&tabId=${TAB_ID}&client=${client}${query}`);
  const peer = routes.socket();
  routes.events?.onOpen?.(new Event("open"), peer.context);
  return peer;
}

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
    logBestEffortFailure: vi.fn(),
    logUnexpectedJsonParseFailure: vi.fn(),
    logUnexpectedWsSendFailure: vi.fn(),
  });

  const socket = () => {
    const sent: string[] = [];
    const close = vi.fn();
    return { sent, close, context: { send: (frame: string) => sent.push(frame), close } as unknown as WSContext };
  };
  return { app, socket, get events() { return events; }, getPrincipal, attach, attachOwnership };
}

describe("terminal WebSocket route registration", () => {
  it.each([
    { request: "&inputCapability=binary-input-v1", expected: ["binary-input-v1"] },
    { request: "&inputCapability=binary-input-v1&scrollCapability=native-scroll-v1", expected: ["binary-input-v1", "native-scroll-v1"] },
    { request: "", expected: undefined },
  ])("projects attached capabilities for Electron request $request", async ({ request, expected }) => {
    const routes = authorizedRoutes({ accessScope: "owner" });
    const peer = await openTab(routes, request, "electron");
    await vi.waitFor(() => expect(routes.attach).toHaveBeenCalledOnce());
    routes.attach.mock.calls[0]![0].onFrame({
      type: "attached", terminalRef: TERMINAL_REF, revision: 1,
      canonicalSize: { cols: 120, rows: 36 }, nextSeq: 0,
      capabilities: ["binary-input-v1", "native-scroll-v1"],
    });
    expect(peer.sent).toHaveLength(1);
    expect(JSON.parse(peer.sent[0]!)).toMatchObject({
      type: "attached", terminalRef: TERMINAL_REF, ownership: "writer",
      ...(expected ? { capabilities: expected } : {}),
    });
    if (!expected) expect(JSON.parse(peer.sent[0]!)).not.toHaveProperty("capabilities");
  });

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

  it("rejects an unknown scroll capability before principal or runtime access", async () => {
    const routes = mountedRoutes();
    await routes.app.request(`/ws/terminal/tab?workspaceId=${WORKSPACE_ID}&tabId=${TAB_ID}&client=electron&scrollCapability=native-scroll-v2`);
    const peer = routes.socket();
    routes.events?.onOpen?.(new Event("open"), peer.context);

    expect(peer.sent).toEqual([JSON.stringify({ type: "error", code: "invalid_request", message: "Invalid request" })]);
    expect(peer.close).toHaveBeenCalledOnce();
    expect(routes.getPrincipal).not.toHaveBeenCalled();
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

  it("authorizes the Chat binding before the workspace admission and the runtime attach", async () => {
    const routes = authorizedRoutes({ accessScope: "chat", repository: repositoryDouble(true) });
    const peer = await openTab(routes, "&chat=chat_01hzzzzzzzzzzzzzzzzzzzzzzz");

    await vi.waitFor(() => expect(routes.attach).toHaveBeenCalledOnce());
    expect(routes.chatRepository?.getTerminalBinding).toHaveBeenCalledWith(
      { type: "personal", ownerId: OWNER_ID },
      "chat_01hzzzzzzzzzzzzzzzzzzzzzzz",
      REF_KEY,
    );
    expect(routes.order).toEqual(["binding", "admission:run", "attach"]);
    expect(routes.withWorkspace).toHaveBeenCalledWith(OWNER_ID, WORKSPACE_ID, "run", expect.any(Function));
    expect(peer.sent).toEqual([]);
  });

  it("denies a Chat-scoped tab whose binding is missing before attaching", async () => {
    const routes = authorizedRoutes({ accessScope: "chat", repository: repositoryDouble(false) });
    const peer = await openTab(routes, "&chat=chat_01hzzzzzzzzzzzzzzzzzzzzzzz");

    await vi.waitFor(() => expect(peer.close).toHaveBeenCalledOnce());
    expect(routes.attach).not.toHaveBeenCalled();
    expect(routes.withWorkspace).not.toHaveBeenCalled();
    expect(peer.sent).toEqual([JSON.stringify({ type: "error", code: "attach_failed", message: "Shell attach failed" })]);
  });

  it("fails closed when a Chat-scoped tab is attached without Chat context", async () => {
    const routes = authorizedRoutes({ accessScope: "chat", repository: repositoryDouble(true) });
    const peer = await openTab(routes, "");

    await vi.waitFor(() => expect(peer.close).toHaveBeenCalledOnce());
    expect(routes.attach).not.toHaveBeenCalled();
    expect(routes.withWorkspace).not.toHaveBeenCalled();
  });

  it("fails closed when a shared tab needs the repository and none is wired", async () => {
    const routes = authorizedRoutes({ accessScope: "shared" });
    const peer = await openTab(routes, "");

    await vi.waitFor(() => expect(peer.close).toHaveBeenCalledOnce());
    expect(routes.attach).not.toHaveBeenCalled();
  });

  it("requires Chat context for an owner-scoped ref that is already Chat-bound", async () => {
    const routes = authorizedRoutes({ accessScope: "owner", repository: repositoryDouble(true) });
    const peer = await openTab(routes, "");

    await vi.waitFor(() => expect(peer.close).toHaveBeenCalledOnce());
    expect(routes.chatRepository?.listBoundTerminalSessionIds).toHaveBeenCalledWith(
      { type: "personal", ownerId: OWNER_ID },
      [REF_KEY],
    );
    expect(routes.attach).not.toHaveBeenCalled();
  });

  it("admits every client frame through the workspace admission before forwarding it", async () => {
    const routes = authorizedRoutes({ accessScope: "owner", repository: repositoryDouble(false) });
    const peer = await openTab(routes, "");
    await vi.waitFor(() => expect(routes.attach).toHaveBeenCalledOnce());
    routes.order.splice(0);

    routes.events?.onMessage?.(
      { data: JSON.stringify({ type: "ping", terminalRef: TERMINAL_REF }) } as never,
      peer.context,
    );

    await vi.waitFor(() => expect(routes.send).toHaveBeenCalledOnce());
    expect(routes.order).toEqual(["admission:run", "runtime-send:ping"]);
  });
  it("attaches the URL the CLI builds for a sized TTY as a hard writer", async () => {
    const routes = authorizedRoutes({ accessScope: "owner", repository: repositoryDouble(false) });
    const url = new URL(createShellClient({ gatewayUrl: "http://gateway" })
      .createAttachUrl(TERMINAL_REF, { fromSeq: 0, size: { cols: 100, rows: 30 } }));
    await routes.app.request(`${url.pathname}${url.search}`);
    const peer = routes.socket();
    routes.events?.onOpen?.(new Event("open"), peer.context);

    await vi.waitFor(() => expect(routes.attach).toHaveBeenCalledOnce());
    expect(routes.attach).toHaveBeenCalledWith(expect.objectContaining({ mode: "hard", size: { cols: 100, rows: 30 } }));
    expect(peer.sent).toEqual([]);
  });

  it("keeps accepting the sized client=hard declaration from installed CLIs", async () => {
    const routes = authorizedRoutes({ accessScope: "owner", repository: repositoryDouble(false) });
    await routes.app.request(
      `/ws/terminal/tab?workspaceId=${WORKSPACE_ID}&tabId=${TAB_ID}&client=hard&cols=100&rows=30&lease=exclusive&fromSeq=0`,
    );
    const peer = routes.socket();
    routes.events?.onOpen?.(new Event("open"), peer.context);

    await vi.waitFor(() => expect(routes.attach).toHaveBeenCalledOnce());
    expect(routes.attach).toHaveBeenCalledWith(expect.objectContaining({
      mode: "hard",
      size: { cols: 100, rows: 30 },
      viewerId: expect.stringMatching(/^cli:/),
    }));
    expect(peer.sent).toEqual([]);
  });
});
