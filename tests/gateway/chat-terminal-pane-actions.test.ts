import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createGatewayChatTerminalWiring } from "../../packages/gateway/src/chat/terminal-wiring.js";
import { createUserSystemdZellijAdapter } from "../../packages/gateway/src/shell/user-systemd-zellij-adapter.js";
import { createShellRoutes } from "../../packages/gateway/src/shell/routes.js";

function fixture(options: { mismatch?: boolean; stale?: boolean; unavailable?: boolean } = {}) {
  const action = vi.fn(async () => undefined);
  const getBinding = vi.fn(async () => options.mismatch ? null : { sessionCreatedAt: "2026-09-01T00:00:00.000Z" });
  const get = vi.fn(async () => ({ name: "workspace_shell", status: "active", incarnationVerified: true, createdAt: options.stale ? "2026-09-02T00:00:00.000Z" : "2026-09-01T00:00:00.000Z" }));
  const wiring = createGatewayChatTerminalWiring({
    repository: { getTerminalBinding: getBinding, listBoundTerminalSessionIds: vi.fn(async () => ["workspace_shell"]) },
    getPrincipal: () => ({ userId: "owner" }) as never,
    registry: { get },
    paneActions: options.unavailable ? undefined : { paneAction: action },
    shellWs: { open: vi.fn() },
    onUnexpectedSendFailure: vi.fn(),
  });
  const standaloneGet = vi.fn(async () => { throw new Error("standalone registry cannot see workspace"); });
  const app = new Hono();
  app.route("/api/terminal", createShellRoutes({
    registry: { get: standaloneGet, list: vi.fn(), create: vi.fn(), delete: vi.fn() },
    ...wiring.shellRouteDeps,
  }));
  const request = () => app.request("/api/terminal/sessions/workspace_shell/pane-actions?chatId=chat_owner", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "split", direction: "right" }),
  });
  return { request, action, getBinding, get, standaloneGet };
}

describe("Chat pane actions through production route wiring", () => {
  it("authorizes owner, Chat binding and live incarnation before using Chat's managed adapter", async () => {
    const { request, action, getBinding, get, standaloneGet } = fixture();
    expect((await request()).status).toBe(200);
    expect(getBinding).toHaveBeenCalledWith({ type: "personal", ownerId: "owner" }, "chat_owner", "workspace_shell");
    expect(get).toHaveBeenCalledWith("workspace_shell");
    expect(action).toHaveBeenCalledWith("workspace_shell", { type: "split", direction: "right" }, { expectedCreatedAt: "2026-09-01T00:00:00.000Z" });
    expect(getBinding.mock.invocationCallOrder[0]).toBeLessThan(get.mock.invocationCallOrder[0]);
    expect(get.mock.invocationCallOrder[0]).toBeLessThan(action.mock.invocationCallOrder[0]);
    expect(standaloneGet).not.toHaveBeenCalled();
  });
  it.each([{ mismatch: true }, { stale: true }])("rejects unauthorized or stale targets %j", async (options) => {
    const { request, action } = fixture(options);
    expect((await request()).status).toBe(404);
    expect(action).not.toHaveBeenCalled();
  });
  it("reports missing Chat action dependency as unavailable", async () => {
    const { request, action } = fixture({ unavailable: true });
    expect((await request()).status).toBe(503);
    expect(action).not.toHaveBeenCalled();
  });
});


it("never dispatches an authorized Chat action to a replacement managed session", async () => {
  const createdAt = "2026-09-01T00:00:00.000Z";
  const runtimeA = "rt_0123456789abcdef0123456789abcdef";
  const runtimeB = "rt_ffffffffffffffffffffffffffffffff";
  const generation = "gen_" + "0".repeat(64);
  const original = { version: 1, runtimeId: runtimeA, sessionName: `matrix-${runtimeA}`, scope: "workspace", kind: "agent", displayName: "workspace_shell", cwd: "/tmp", layoutPath: "/tmp/default.kdl", generation, createdAt };
  let current = original;
  const dispatch = vi.fn(async () => undefined);
  const adapter = createUserSystemdZellijAdapter({
    homePath: "/tmp", generation, includeWorkspaceSessions: true,
    controller: { list: async () => [current], findByDisplayName: async () => current } as never,
    baseAdapter: {} as never, adapterFactory: () => ({ paneAction: dispatch }) as never,
  });
  const get = vi.fn(async () => {
    // Authorization observes A, then a concurrent registry refresh replaces the
    // adapter's display-name cache before the authorized action is dispatched.
    await adapter.listSessions();
    current = { ...original, runtimeId: runtimeB, sessionName: `matrix-${runtimeB}`, createdAt: "2026-09-02T00:00:00.000Z" };
    await adapter.listSessions();
    return { name: "workspace_shell", createdAt, status: "active", incarnationVerified: true };
  });
  const wiring = createGatewayChatTerminalWiring({
    repository: { getTerminalBinding: async () => ({ sessionCreatedAt: createdAt }), listBoundTerminalSessionIds: async () => ["workspace_shell"] },
    getPrincipal: () => ({ userId: "owner" }) as never,
    registry: { get }, paneActions: adapter, shellWs: { open: vi.fn() }, onUnexpectedSendFailure: vi.fn(),
  });
  const app = new Hono();
  app.route("/api/terminal", createShellRoutes({ registry: {} as never, ...wiring.shellRouteDeps }));
  const response = await app.request("/api/terminal/sessions/workspace_shell/pane-actions?chatId=chat_owner", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "close" }),
  });
  expect(response.status).toBe(404);
  expect(dispatch).not.toHaveBeenCalled();
});
