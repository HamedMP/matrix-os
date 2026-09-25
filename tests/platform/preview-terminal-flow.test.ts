import { EventEmitter } from "node:events";
import type { Server, IncomingMessage } from "node:http";
import { Hono } from "hono";
import type { WSEvents, WSContext } from "hono/ws";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../packages/platform/src/main.js";
import { createClerkAuth } from "../../packages/platform/src/clerk-auth.js";
import { insertUserMachine, updateUserMachine, getActiveUserMachineByHandle, type PlatformDB } from "../../packages/platform/src/db.js";
import { registerPlatformWebSocketUpgradeHandler } from "../../packages/platform/src/platform-websocket-upgrade.js";
import { buildPlatformVerificationToken } from "../../packages/platform/src/platform-token.js";
import { verifySyncJwt } from "../../packages/platform/src/sync-jwt.js";
import { authMiddleware, readPreviewTerminalOwner } from "../../packages/gateway/src/auth.js";
import { requireRequestPrincipal } from "../../packages/gateway/src/request-principal.js";
import {
  createTerminalWorkspaceRoutes,
  terminalResourceOwnerId,
  terminalRuntimeRefAccess,
} from "../../packages/gateway/src/shell/workspace-routes.js";
import { getGatewayUrl, getGatewayWs } from "../../shell/src/lib/gateway.js";
import { JWT_SECRET, setupProxyRoutingTest, cleanupProxyRoutingTest, stubOrchestrator } from "./proxy-routing-test-utils.js";

const tls = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock("node:tls", async (original) => ({ ...await original<typeof import("node:tls")>(), connect: tls.connect }));
const handle = "pr-1644";
const owner = "user_owner";
const collaborators = ["user_collaborator_one", "user_collaborator_two"];
const platformSecret = "platform-secret-preview-integration";
const workspaceId = "tws_0123456789abcdef0123456789abcdef";
const createdAt = "2026-09-15T00:00:00.000Z";

class Transport extends EventEmitter {
  writes: string[] = [];
  destroyed = false;
  write(value: string) { this.writes.push(value); return true; }
  pipe() { return this; }
  destroy() { this.destroyed = true; return this; }
}
let db: PlatformDB;
beforeEach(async () => {
  db = await setupProxyRoutingTest();
  vi.stubEnv("PLATFORM_JWT_SECRET", JWT_SECRET);
  vi.stubEnv("PLATFORM_JWT_PUBLIC_KEY", "");
  vi.stubEnv("MATRIX_HANDLE", handle);
  vi.stubEnv("MATRIX_RUNTIME_SLOT", handle);
  vi.stubEnv("MATRIX_USER_ID", owner);
  vi.stubEnv("MATRIX_CLERK_USER_ID", owner);
  await insertUserMachine(db, {
    machineId: "9f05824c-8d0a-4d83-9cb4-b312d43ff141", clerkUserId: owner,
    handle, runtimeSlot: handle, provisioningClass: "preview", accessClerkUserIds: collaborators,
    status: "running", publicIPv4: "203.0.113.41", imageVersion: "test", provisionedAt: createdAt,
  });
});
afterEach(async () => { await cleanupProxyRoutingTest(db); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

function fixture() {
  let actorId = owner;
  const clerkAuth = createClerkAuth({ verifyToken: vi.fn(async () => ({ sub: actorId })) });
  const platform = createApp({ db, clerkAuth, orchestrator: stubOrchestrator(), platformSecret });
  const workspace = { id: workspaceId, scope: "global", tabs: [] as Array<{ id: string; accessScope: string }> };
  const input = vi.fn();
  const runtime = {
    listWorkspaces: vi.fn(async () => [workspace]), ensureWorkspace: vi.fn(async () => workspace),
    createTab: vi.fn(async (_id, options) => {
      const tab = { ...options, id: `tt_${String(workspace.tabs.length + 1).padStart(32, "0")}`, createdAt };
      workspace.tabs.push(tab); return tab;
    }),
    deletionImpact: vi.fn(), deleteWorkspace: vi.fn(),
    attach: vi.fn((options) => ({
      close: vi.fn(), send: (frame: { type: string; data?: string }) => {
        input(frame);
        options.onFrame({ type: "output", terminalRef: options.ref, revision: 1, seq: 1, data: `output:${frame.data}` });
      },
    })),
  };
  const gateway = new Hono();
  gateway.use("*", authMiddleware(buildPlatformVerificationToken(handle, platformSecret)));
  const actors: string[] = [];
  gateway.use("*", async (c, next) => { actors.push(requireRequestPrincipal(c).userId); await next(); });
  gateway.route("/api/terminal", createTerminalWorkspaceRoutes({
    runtime: runtime as never, getPrincipal: requireRequestPrincipal, terminalOwnerIds: [owner],
    getPreviewTerminalOwner: readPreviewTerminalOwner,
  }));
  const events: WSEvents[] = [];
  const repository = {
    getTerminalBinding: vi.fn(async () => null),
    listBoundTerminalSessionIds: vi.fn(async () => [] as string[]),
  };
  gateway.get("/ws/terminal/tab", (c) => {
    const principal = requireRequestPrincipal(c);
    const previewOwner = readPreviewTerminalOwner(c);
    const ref = { workspaceId: c.req.query("workspaceId")!, tabId: c.req.query("tabId")! };
    const chatId = c.req.query("chat");
    let stream: ReturnType<typeof runtime.attach> | undefined;
    events.push({
      onOpen(_event, ws) {
        void (async () => {
          const access = await terminalRuntimeRefAccess(principal, [owner], runtime as never, ref, previewOwner);
          if (access === "not_found" || access === "unavailable") throw new Error("Terminal denied");
          const resourceOwnerId = terminalResourceOwnerId(principal, previewOwner);
          const refKey = `${ref.workspaceId}:${ref.tabId}`;
          if (chatId) {
            const binding = await repository.getTerminalBinding(
              { type: "personal", ownerId: principal.userId }, chatId, refKey,
            );
            if (!binding) throw new Error("Chat terminal denied");
          } else {
            if (access === "chat_required") throw new Error("Chat context required");
            const bound = await repository.listBoundTerminalSessionIds(
              { type: "personal", ownerId: resourceOwnerId }, [refKey],
            );
            if (bound.includes(refKey)) throw new Error("Chat context required");
          }
          stream = runtime.attach({
            ref,
            onFrame: (frame) => ws.send(JSON.stringify(frame)),
          });
        })().catch((error: unknown) => {
          console.error("[test] terminal attachment denied", error instanceof Error ? error.message : "unknown_error");
          ws.close();
        });
      },
      onMessage(event) {
        const frame = JSON.parse(String(event.data));
        stream?.send(frame);
      },
      onClose() { stream?.close(); },
    });
    return c.text("upgrade");
  });
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path === "/") return new Response("preview shell");
    return gateway.request(`http://gateway${path}`, init as RequestInit);
  });
  const server = new EventEmitter();
  const permitted = { runtimeProxyAllowed: true } as never;
  registerPlatformWebSocketUpgradeHandler({
    server: server as Server, app: { capturePlatformEvent: vi.fn() }, db, clerkAuth,
    env: {}, platformSecret, platformJwtSecret: JWT_SECRET, legacyContainerRoutingEnabled: false,
    codeServerPort: 8080, getRuntimeEntitlementDecision: () => permitted,
    getRuntimeEntitlementDecisionForUser: async () => permitted,
  });
  const request = (path: string, init?: RequestInit, host = "app.matrix-os.com") => platform.request(`/vm/${handle}${path}`, {
    ...init, headers: { host, authorization: "Bearer clerk-session",
      "content-type": "application/json", "x-platform-preview-terminal": "client-forgery",
      ...init?.headers },
  });
  const upgrade = async (jwt: string, tabId: string, targetHandle = handle, chatId?: string, host = "app.matrix-os.com") => {
    const upstream = new Transport();
    tls.connect.mockImplementation((_options, connected) => { queueMicrotask(connected); return upstream; });
    const socket = new Transport();
    const path = `/vm/${targetHandle}/ws/terminal/tab?workspaceId=${workspaceId}&tabId=${tabId}&client=browser&token=${encodeURIComponent(jwt)}${chatId ? `&chat=${chatId}` : ""}`;
    const req = { url: path, method: "GET", headers: { host, upgrade: "websocket",
      "x-platform-user-id": owner, "x-platform-verified": "forged", "x-platform-preview-terminal": "forged" } };
    await server.listeners("upgrade")[0](req as IncomingMessage, socket, Buffer.alloc(0));
    if (socket.destroyed) return { denied: true };
    expect(upstream.writes).toHaveLength(1);
    const [line, ...rawHeaders] = upstream.writes[0].split("\r\n");
    const headers = new Headers();
    for (const entry of rawHeaders) {
      const separator = entry.indexOf(":");
      if (separator > 0) headers.append(entry.slice(0, separator), entry.slice(separator + 1).trim());
    }
    expect(headers.get("x-platform-user-id")).toBe(actorId);
    expect(upstream.writes[0]).not.toContain("forged");
    expect(upstream.writes[0]).not.toContain(jwt);
    await gateway.request(`http://gateway${line.split(" ")[1]}`, { headers });
    const handler = events.at(-1)!;
    const sent: unknown[] = [];
    const ws = { send: (value: string) => sent.push(JSON.parse(value)), close: vi.fn() } as unknown as WSContext;
    handler.onOpen?.(new Event("open"), ws);
    await vi.waitFor(() => expect(runtime.attach.mock.calls.length > 0 || vi.mocked(ws.close).mock.calls.length > 0).toBe(true));
    return { denied: vi.mocked(ws.close).mock.calls.length > 0, handler, ws, sent };
  };
  return { platform, request, upgrade, actors, input, runtime, workspace, repository, setActor: (id: string) => { actorId = id; } };
}

describe("Clerk preview collaborator terminal flow", () => {
  it("binds a PR hostname to its own preview runtime on HTTP and WebSocket paths", async () => {
    const ownHost = `pr-1644.preview.matrix-os.com`;
    const otherHost = `pr-1645.preview.matrix-os.com`;
    vi.stubEnv("MATRIX_APP_DOMAIN_HOSTS", `${ownHost},${otherHost}`);
    const f = fixture();
    expect((await f.request("/api/terminal/workspaces", undefined, ownHost)).status).toBe(200);
    expect((await f.request("/api/terminal/workspaces", undefined, otherHost)).status).toBe(404);
    const { token } = await (await f.request("/api/auth/ws-token", undefined, ownHost)).json();
    expect((await f.upgrade(token, "tt_00000000000000000000000000000001", handle, undefined, otherHost)).denied).toBe(true);
    expect(tls.connect).not.toHaveBeenCalled();
  });

  it("shares tabs across owner and two collaborators through HTTP, token, WS input/output and reconnect", async () => {
    const f = fixture();
    vi.stubGlobal("window", { location: { origin: "https://app.matrix-os.com", host: "app.matrix-os.com",
      protocol: "https:", pathname: `/vm/${handle}`, search: "" } });
    expect(getGatewayUrl()).toBe(`https://app.matrix-os.com/vm/${handle}`);
    expect(getGatewayWs()).toBe(`wss://app.matrix-os.com/vm/${handle}/ws`);
    for (const actor of [owner, ...collaborators]) {
      f.setActor(actor);
      expect((await f.request("")).status).toBe(200);
      expect((await f.request("/api/terminal/workspaces")).status).toBe(200);
      expect((await f.request("/api/terminal/workspaces/ensure", { method: "POST", body: "{}" })).status).toBe(200);
      const created = await f.request(`/api/terminal/workspaces/${workspaceId}/tabs`, {
        method: "POST", body: JSON.stringify({ name: "Shared", cwd: "/" }),
      });
      expect(created.status).toBe(201);
      const { tab: createdTab } = await created.json();
      expect(f.workspace.tabs).toContainEqual(expect.objectContaining({ id: createdTab.id }));
      const tab = f.workspace.tabs[0]; // Every actor attaches the same owner's shared tab.
      const tokenResponse = await f.request("/api/auth/ws-token");
      const { token } = await tokenResponse.json();
      expect((await verifySyncJwt(token, { secret: JWT_SECRET })).sub).toBe(actor);
      for (let attempt = 0; attempt < 2; attempt++) {
        f.runtime.attach.mockClear();
        const connection = await f.upgrade(token, tab.id);
        expect(connection.denied).toBe(false);
        connection.handler!.onMessage?.(new MessageEvent("message", { data: JSON.stringify({ type: "input", terminalRef: { workspaceId, tabId: tab.id }, data: "echo shared\r" }) }), connection.ws!);
        await vi.waitFor(() => expect(connection.sent).toContainEqual({ type: "output", terminalRef: { workspaceId, tabId: tab.id }, revision: 1, seq: 1, data: "output:echo shared\r" }));
        connection.handler!.onClose?.(new Event("close") as CloseEvent, connection.ws!);
      }
      expect(f.actors.at(-1)).toBe(actor);
      expect(f.repository.listBoundTerminalSessionIds).toHaveBeenLastCalledWith(
        { type: "personal", ownerId: owner }, expect.any(Array));
    }
    const discovery = await (await f.request("/api/terminal/workspaces")).json();
    expect(discovery.workspaces[0].tabs).toHaveLength(3);
  });
  it("does not delegate customer machines even with preview-shaped names and a populated allowlist", async () => {
    const f = fixture();
    f.setActor(collaborators[0]);
    const { token } = await (await f.request("/api/auth/ws-token")).json();
    const machine = await getActiveUserMachineByHandle(db, handle);
    await updateUserMachine(db, machine!.machineId, { provisioningClass: "customer" });
    expect((await f.request("/api/terminal/workspaces")).status).toBe(404);
    expect((await f.request("/api/auth/ws-token")).status).toBe(404);
    expect((await f.upgrade(token, "tt_00000000000000000000000000000001")).denied).toBe(true);
    expect(f.runtime.listWorkspaces).not.toHaveBeenCalled();
    expect(f.runtime.attach).not.toHaveBeenCalled();
  });
  it("preserves Chat authorization for legacy and explicitly Chat-bound tabs", async () => {
    const f = fixture();
    f.setActor(collaborators[0]);
    const created = await f.request(`/api/terminal/workspaces/${workspaceId}/tabs`, {
      method: "POST", body: JSON.stringify({ name: "Shared", cwd: "/" }),
    });
    const { tab } = await created.json();
    f.workspace.tabs[0].accessScope = "legacy";
    const refKey = `${workspaceId}:${tab.id}`;
    f.repository.listBoundTerminalSessionIds.mockResolvedValue([refKey]);
    const { token } = await (await f.request("/api/auth/ws-token")).json();
    expect((await f.upgrade(token, tab.id)).denied).toBe(true);
    expect(f.repository.listBoundTerminalSessionIds).toHaveBeenCalledWith(
      { type: "personal", ownerId: owner }, [refKey]);
    f.workspace.tabs[0].accessScope = "chat";
    expect((await f.upgrade(token, tab.id, handle, "chat_private")).denied).toBe(true);
    expect(f.repository.getTerminalBinding).toHaveBeenCalledWith(
      { type: "personal", ownerId: collaborators[0] }, "chat_private", refKey);
    expect(f.runtime.attach).not.toHaveBeenCalled();
  });
  it("rejects an unlisted actor and replay to a different preview, and rechecks a removed collaborator", async () => {
    const f = fixture();
    f.setActor("user_unlisted");
    expect((await f.request("/api/terminal/workspaces")).status).toBe(404);
    expect((await f.request("/api/auth/ws-token")).status).toBe(404);
    f.setActor(collaborators[0]);
    const { token } = await (await f.request("/api/auth/ws-token")).json();
    expect((await f.upgrade(token, "tt_00000000000000000000000000000001", "pr-9999")).denied).toBe(true);
    const machine = await getActiveUserMachineByHandle(db, handle);
    await updateUserMachine(db, machine!.machineId, { accessClerkUserIds: [] });
    expect((await f.request("/api/terminal/workspaces")).status).toBe(404);
    expect((await f.upgrade(token, "tt_00000000000000000000000000000001")).denied).toBe(true);
    expect(f.runtime.attach).not.toHaveBeenCalled();
  });
});
