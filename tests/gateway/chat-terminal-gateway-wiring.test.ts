import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import type { UpgradeWebSocket, WSEvents, WSContext } from "hono/ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createGatewayChatTerminalWiring,
} from "../../packages/gateway/src/chat/terminal-wiring.js";
import {
  AUTH_CONTEXT_READY_CONTEXT_KEY,
  JWT_CLAIMS_CONTEXT_KEY,
  ownerScopeFromPrincipal,
  requireRequestPrincipal,
} from "../../packages/gateway/src/request-principal.js";
import { createShellRoutes } from "../../packages/gateway/src/shell/routes.js";
import { createWorkspaceRoutes } from "../../packages/gateway/src/workspace-routes.js";

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function homePath(): string {
  const home = mkdtempSync(join(tmpdir(), "chat-terminal-wiring-"));
  mkdirSync(join(home, "system"), { recursive: true });
  homes.push(home);
  return home;
}

function installPrincipal(app: Hono, userId = "user_current"): void {
  app.use("*", async (c, next) => {
    c.set(AUTH_CONTEXT_READY_CONTEXT_KEY as never, true);
    c.set(JWT_CLAIMS_CONTEXT_KEY as never, { sub: userId });
    await next();
  });
}

function fakeUpgrade(captured: { events?: WSEvents }): UpgradeWebSocket {
  return ((createEvents: (c: never) => WSEvents | Promise<WSEvents>) => async (c: never) => {
    captured.events = await createEvents(c);
    return new Response(JSON.stringify({ upgraded: true }), {
      headers: { "content-type": "application/json" },
    });
  }) as UpgradeWebSocket;
}

function fakeSocket() {
  const sent: string[] = [];
  const close = vi.fn();
  return {
    sent,
    close,
    context: { send: (value: string) => sent.push(value), close } as unknown as WSContext,
  };
}

async function waitForCall(mock: ReturnType<typeof vi.fn>): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (mock.mock.calls.length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("expected call was not observed");
}

function repository(bound = true) {
  return {
    getTerminalBinding: vi.fn(async () => (
      bound ? { sessionCreatedAt: "2026-08-28T10:00:00.000Z" } : null
    )),
    listBoundTerminalSessionIds: vi.fn(async (_owner, ids: readonly string[]) => (
      ids.filter((id) => id === "terminal_bound")
    )),
  };
}

function createWiring(input: {
  repository: ReturnType<typeof repository> | null;
  registry?: { get: ReturnType<typeof vi.fn> };
  open?: ReturnType<typeof vi.fn>;
}) {
  return createGatewayChatTerminalWiring({
    repository: input.repository,
    getPrincipal: (c) => requireRequestPrincipal(c),
    registry: input.registry ?? {
      get: vi.fn(async (name: string) => ({
        name,
        status: "active",
        recoverable: false,
        createdAt: "2026-08-28T10:00:00.000Z",
        incarnationVerified: true,
      })),
    },
    shellWs: { open: input.open ?? vi.fn(async () => ({ onMessage: vi.fn(), onClose: vi.fn() })) },
    onUnexpectedSendFailure: vi.fn(),
  });
}

describe("createGateway Chat terminal production wiring", () => {
  it("keeps createGateway on the workspace/tab runtime without constructing a legacy Zellij registry", () => {
    const source = readFileSync(join(process.cwd(), "packages/gateway/src/server.ts"), "utf8");
    expect(source).toContain("new TerminalRuntimeSocketClient({");
    expect(source).toContain('"/ws/terminal/tab"');
    expect(source).toContain("chatBoundShellRouteDeps");
    expect(source).toContain("chatBoundWorkspaceRouteDeps");
    expect(source).toContain("getTerminalBinding(");
    expect(source).toContain("listBoundTerminalSessionIds(");
    expect(source).toContain("terminalRuntimeOwnerAccess(principal, terminalRuntimeOwnerIds)");
    expect(source.indexOf("terminalRuntimeOwnerAccess(principal, terminalRuntimeOwnerIds)")).toBeLessThan(
      source.indexOf("if (chatRepository)", source.indexOf('"/ws/terminal/tab"')),
    );
    expect(source).not.toContain("createUserSystemdZellijAdapter({");
    expect(source).not.toContain("new ZellijShellRegistry({");
    expect(source).not.toContain("createGatewayChatTerminalWiring({");
  });

  it("allows the real chat query route only after current-principal authorization", async () => {
    const repo = repository(true);
    const open = vi.fn(async () => ({ onMessage: vi.fn(), onClose: vi.fn() }));
    const wiring = createWiring({ repository: repo, open });
    const app = new Hono();
    installPrincipal(app, "user_route_owner");
    const captured: { events?: WSEvents } = {};
    wiring.registerSessionRoute(app, fakeUpgrade(captured));

    const response = await app.request("/ws/terminal/session?session=terminal_bound&chat=chat_selected");
    expect(response.status).toBe(200);
    const socket = fakeSocket();
    captured.events?.onOpen?.(new Event("open"), socket.context);
    await waitForCall(open);

    expect(repo.getTerminalBinding).toHaveBeenCalledWith(
      { type: "personal", ownerId: "user_route_owner" },
      "chat_selected",
      "terminal_bound",
    );
    expect(open).toHaveBeenCalledOnce();
    expect(socket.sent).toEqual([]);
  });

  it("parses the terminal WebSocket query through one bounded contract", async () => {
    const repo = repository(true);
    const open = vi.fn(async () => ({ onMessage: vi.fn(), onClose: vi.fn() }));
    const wiring = createWiring({ repository: repo, open });
    const app = new Hono();
    installPrincipal(app);
    const captured: { events?: WSEvents } = {};
    wiring.registerSessionRoute(app, fakeUpgrade(captured));

    await app.request(
      "/ws/terminal/session?session=terminal_bound&chat=chat_selected&fromSeq=42&client=soft&cols=120&rows=40&lease=exclusive&runtime=pr-1360",
    );
    const socket = fakeSocket();
    captured.events?.onOpen?.(new Event("open"), socket.context);
    await waitForCall(open);

    expect(open).toHaveBeenCalledWith(expect.objectContaining({
      session: "terminal_bound",
      fromSeq: 42,
      clientClass: "soft",
      declaredSize: { cols: 120, rows: 40 },
      exclusiveLease: true,
    }));
  });

  it("accepts the bounded query token already consumed by WebSocket authentication", async () => {
    const repo = repository(true);
    const open = vi.fn(async () => ({ onMessage: vi.fn(), onClose: vi.fn() }));
    const wiring = createWiring({ repository: repo, open });
    const app = new Hono();
    installPrincipal(app);
    const captured: { events?: WSEvents } = {};
    wiring.registerSessionRoute(app, fakeUpgrade(captured));

    await app.request(
      "/ws/terminal/session?session=terminal_bound&chat=chat_selected&token=signed-query-token",
    );
    const socket = fakeSocket();
    captured.events?.onOpen?.(new Event("open"), socket.context);
    await waitForCall(open);

    expect(open).toHaveBeenCalledOnce();
    expect(socket.sent).toEqual([]);
  });

  it.each([
    "session=terminal_bound&fromSeq=-1",
    "session=terminal_bound&fromSeq=9007199254740992",
    "session=terminal_bound&client=unknown",
    "session=terminal_bound&cols=501&rows=40",
    "session=terminal_bound&cols=120",
    "session=terminal_bound&lease=shared",
    "session=not%20valid",
    "session=terminal_bound&chat=not%20valid",
    "session=terminal_bound&runtime=not_valid",
    "session=terminal_bound&unknown=value",
  ])("rejects an invalid terminal WebSocket query before dependency access: %s", async (query) => {
    const repo = repository(true);
    const open = vi.fn(async () => ({ onMessage: vi.fn(), onClose: vi.fn() }));
    const getPrincipal = vi.fn(() => ({ userId: "user_route_owner", source: "jwt" as const }));
    const wiring = createGatewayChatTerminalWiring({
      repository: repo,
      getPrincipal,
      registry: {
        get: vi.fn(async (name: string) => ({
          name,
          status: "active",
          recoverable: false,
          createdAt: "2026-08-28T10:00:00.000Z",
          incarnationVerified: true,
        })),
      },
      shellWs: { open },
      onUnexpectedSendFailure: vi.fn(),
    });
    const app = new Hono();
    const captured: { events?: WSEvents } = {};
    wiring.registerSessionRoute(app, fakeUpgrade(captured));

    await app.request(`/ws/terminal/session?${query}`);
    const socket = fakeSocket();
    captured.events?.onOpen?.(new Event("open"), socket.context);

    expect(socket.sent).toEqual([JSON.stringify({
      type: "error",
      code: "invalid_request",
      message: "Invalid request",
    })]);
    expect(socket.close).toHaveBeenCalledOnce();
    expect(getPrincipal).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it.each([
    { sessionId: "terminal_bound", shouldOpen: false },
    { sessionId: "terminal_manual", shouldOpen: true },
  ])("checks owner-scoped bindings before attaching $sessionId without a Chat query", async ({
    sessionId,
    shouldOpen,
  }) => {
    const repo = repository(true);
    const open = vi.fn(async () => ({ onMessage: vi.fn(), onClose: vi.fn() }));
    const wiring = createWiring({ repository: repo, open });
    const app = new Hono();
    installPrincipal(app, "user_route_owner");
    const captured: { events?: WSEvents } = {};
    wiring.registerSessionRoute(app, fakeUpgrade(captured));

    await app.request(`/ws/terminal/session?session=${sessionId}`);
    const socket = fakeSocket();
    captured.events?.onOpen?.(new Event("open"), socket.context);
    await waitForCall(shouldOpen ? open : socket.close);

    expect(repo.listBoundTerminalSessionIds).toHaveBeenCalledWith(
      { type: "personal", ownerId: "user_route_owner" },
      [sessionId],
    );
    if (shouldOpen) {
      expect(open).toHaveBeenCalledOnce();
      expect(socket.sent).toEqual([]);
    } else {
      expect(open).not.toHaveBeenCalled();
      expect(socket.sent).toEqual([JSON.stringify({
        type: "error",
        code: "attach_failed",
        message: "Shell attach failed",
      })]);
    }
  });

  it.each([
    { label: "unbound session", repository: repository(false), installAuth: true },
    { label: "missing repository", repository: null, installAuth: true },
    { label: "missing principal", repository: repository(true), installAuth: false },
  ])("fails closed through the real handler for $label", async ({ repository: repo, installAuth }) => {
    const open = vi.fn(async () => ({ onMessage: vi.fn(), onClose: vi.fn() }));
    const getPrincipal = installAuth
      ? (c: never) => requireRequestPrincipal(c)
      : (c: never) => requireRequestPrincipal(c, {
          authEnabled: true,
          configuredUserId: undefined,
          isLocalDevelopment: false,
          isProduction: true,
          isTrustedSingleUserGateway: false,
        });
    const wiring = createGatewayChatTerminalWiring({
      repository: repo,
      getPrincipal,
      registry: {
        get: vi.fn(async (name: string) => ({
          name,
          status: "active",
          recoverable: false,
          createdAt: "2026-08-28T10:00:00.000Z",
          incarnationVerified: true,
        })),
      },
      shellWs: { open },
      onUnexpectedSendFailure: vi.fn(),
    });
    const app = new Hono();
    if (installAuth) installPrincipal(app);
    const captured: { events?: WSEvents } = {};
    wiring.registerSessionRoute(app, fakeUpgrade(captured));
    await app.request("/ws/terminal/session?session=terminal_bound&chat=chat_selected");
    const socket = fakeSocket();

    captured.events?.onOpen?.(new Event("open"), socket.context);
    await waitForCall(socket.close);

    expect(open).not.toHaveBeenCalled();
    expect(socket.sent).toEqual([JSON.stringify({
      type: "error",
      code: "attach_failed",
      message: "Shell attach failed",
    })]);
  });

  it("retires the legacy session mount and keeps the owner-scoped workspace projection filter", async () => {
    const repo = repository(true);
    const boundRef = {
      workspaceId: "tws_00000000000000000000000000000001",
      tabId: "tt_00000000000000000000000000000001",
    };
    const manualRef = {
      workspaceId: "tws_00000000000000000000000000000002",
      tabId: "tt_00000000000000000000000000000002",
    };
    const boundRefKey = `${boundRef.workspaceId}:${boundRef.tabId}`;
    const manualRefKey = `${manualRef.workspaceId}:${manualRef.tabId}`;
    repo.listBoundTerminalSessionIds.mockImplementation(async (_owner, ids: readonly string[]) => (
      ids.filter((id) => id === boundRefKey)
    ));
    const registry = {
      list: vi.fn(async () => [
        { name: "terminal_bound", status: "active" },
        { name: "terminal_manual", status: "active" },
      ]),
      create: vi.fn(),
      delete: vi.fn(),
    };
    const wiring = createWiring({
      repository: repo,
      registry: {
        get: vi.fn(async (name: string) => ({
          name,
          status: "active",
          recoverable: false,
          createdAt: "2026-08-28T10:00:00.000Z",
        })),
      },
    });
    const app = new Hono();
    installPrincipal(app, "user_mount_owner");
    app.route("/api/terminal", createShellRoutes({
      homePath: homePath(),
      registry,
      ...wiring.shellRouteDeps,
    }));
    app.route("/", createWorkspaceRoutes({
      homePath: homePath(),
      sessionOrchestrator: {
        listSessions: vi.fn(async () => ({
          ok: true,
          sessions: [
            { id: "sess_bound", terminalRef: boundRef },
            { id: "sess_manual", terminalRef: manualRef },
          ],
        })),
      } as never,
      getOwnerScope: (c) => ownerScopeFromPrincipal(requireRequestPrincipal(c)),
      ...wiring.workspaceRouteDeps,
    }));
    // Match createGateway ordering: Workspace owns GET /api/sessions before
    // the compatibility shell mount is registered.
    app.route("/api", createShellRoutes({
      homePath: homePath(),
      registry,
      ...wiring.shellRouteDeps,
    }));

    expect((await app.request("/api/terminal/sessions")).status).toBe(426);
    await expect((await app.request("/api/sessions")).json()).resolves.toEqual({
      sessions: [{ id: "sess_manual", terminalRef: manualRef }],
    });
    expect(repo.listBoundTerminalSessionIds).toHaveBeenCalledTimes(1);
    expect(repo.listBoundTerminalSessionIds).toHaveBeenNthCalledWith(
      1,
      { type: "personal", ownerId: "user_mount_owner" },
      [boundRefKey, manualRefKey],
    );
  });
});
