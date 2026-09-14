import { EventEmitter } from "node:events";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createShellRoutes } from "../../packages/gateway/src/shell/routes.js";
import { createZellijAdapter } from "../../packages/gateway/src/shell/zellij.js";
import { shellError } from "../../packages/gateway/src/shell/errors.js";
import { matrixZellijConfigPaths, renderMatrixZellijConfig } from "../../packages/gateway/src/shell/zellij-config.js";
import { ShellPreferencesPatchSchema, ShellPreferencesSchema } from "../../packages/gateway/src/shell/preferences.js";

function fixture(options: { missing?: boolean; unavailable?: boolean; fail?: boolean } = {}) {
  const paneAction = vi.fn(async () => { if (options.fail) throw new Error("secret provider /opt/private"); });
  const get = vi.fn(async (name: string) => {
    if (options.missing) throw shellError("session_not_found", "Session not found", 404);
    return { name, status: "active" };
  });
  const app = new Hono();
  app.route("/api/terminal", createShellRoutes({
    registry: { get, list: vi.fn(), create: vi.fn(), delete: vi.fn() },
    workspace: options.unavailable ? undefined : { paneAction } as never,
  }));
  const request = (body: unknown, name = "main") => app.request(`/api/terminal/sessions/${name}/pane-actions`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  return { app, request, paneAction, get };
}

describe("terminal pane action route", () => {
  it("resolves the live session before dispatching a validated pane action", async () => {
    const { request, get, paneAction } = fixture();
    const response = await request({ type: "split", direction: "right" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(get).toHaveBeenCalledWith("main");
    expect(paneAction).toHaveBeenCalledWith("main", { type: "split", direction: "right" });
    expect(get.mock.invocationCallOrder[0]).toBeLessThan(paneAction.mock.invocationCallOrder[0]);
  });
  it.each([
    { type: "split", direction: "left" }, { type: "focus", direction: "nope" },
    { type: "scroll", edge: "middle" }, { type: "fullscreen", command: "rm" }, {},
  ])("rejects malformed actions %j", async (body) => {
    const { request, paneAction } = fixture();
    expect((await request(body)).status).toBe(400);
    expect(paneAction).not.toHaveBeenCalled();
  });
  it("rejects malformed JSON and oversized payloads before dispatch", async () => {
    const { app, request, paneAction } = fixture();
    expect((await app.request("/api/terminal/sessions/main/pane-actions", { method: "POST", body: "{" })).status).toBe(400);
    expect((await request({ type: "fullscreen", extra: "a".repeat(2048) })).status).toBe(413);
    expect(paneAction).not.toHaveBeenCalled();
  });
  it("rejects invalid and missing sessions", async () => {
    const { request, paneAction } = fixture({ missing: true });
    expect((await request({ type: "close" }, "bad%3Bname")).status).toBe(400);
    expect((await request({ type: "close" })).status).toBe(404);
    expect(paneAction).not.toHaveBeenCalled();
  });
  it("uses the reconciled session name and rejects inactive sessions", async () => {
    const { request, get, paneAction } = fixture();
    get.mockResolvedValueOnce({ name: "renamed", status: "active" });
    expect((await request({ type: "fullscreen" })).status).toBe(200);
    expect(paneAction).toHaveBeenCalledWith("renamed", { type: "fullscreen" });
    get.mockResolvedValueOnce({ name: "main", status: "exited" });
    expect((await request({ type: "fullscreen" })).status).toBe(404);
    expect(paneAction).toHaveBeenCalledTimes(1);
  });
  it("requires matching Chat authorization and denies context-free access to bound sessions", async () => {
    const paneAction = vi.fn(async () => undefined);
    const authorize = vi.fn(async () => undefined);
    const app = new Hono();
    app.route("/api/terminal", createShellRoutes({
      registry: { get: vi.fn(async () => ({ name: "main", status: "active" })), list: vi.fn(), create: vi.fn(), delete: vi.fn() },
      workspace: { paneAction } as never,
      getPrincipal: () => ({ userId: "owner" }) as never,
      listChatBoundSessionIds: vi.fn(async () => ["main"]),
      chatPaneAction: authorize,
    }));
    const request = (query = "") => app.request(`/api/terminal/sessions/main/pane-actions${query}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "focus", direction: "left" }),
    });
    expect((await request()).status).toBe(404);
    expect(paneAction).not.toHaveBeenCalled();
    expect((await request("?chatId=chat_test")).status).toBe(200);
    expect(authorize).toHaveBeenCalledWith({ userId: "owner" }, { chatId: "chat_test", sessionId: "main", action: { type: "focus", direction: "left" } });
    authorize.mockRejectedValueOnce(shellError("session_not_found", "Session not found", 404));
    expect((await request("?chatId=chat_other")).status).toBe(404);
    expect((await request("?chatId=invalid%3B")).status).toBe(400);
    expect(paneAction).not.toHaveBeenCalled();
  });
  it("reports unavailable dependencies and safe execution failures", async () => {
    expect((await fixture({ unavailable: true }).request({ type: "close" })).status).toBe(503);
    const response = await fixture({ fail: true }).request({ type: "close" });
    expect(response.status).toBe(500);
    expect(await response.text()).not.toMatch(/secret|provider|private/);
  });
});

describe("Zellij pane commands", () => {
  it.each([
    [{ type: "split", direction: "right" }, ["new-pane", "--direction", "right"]],
    [{ type: "split", direction: "down" }, ["new-pane", "--direction", "down"]],
    [{ type: "focus", direction: "left" }, ["move-focus", "left"]],
    [{ type: "resize", direction: "up" }, ["resize", "increase", "up"]],
    [{ type: "fullscreen" }, ["toggle-fullscreen"]],
    [{ type: "scroll", edge: "top" }, ["scroll-to-top"]],
    [{ type: "scroll", edge: "bottom" }, ["scroll-to-bottom"]],
    [{ type: "close" }, ["close-pane"]],
  ])("dispatches %j with argument arrays and a deadline", async (action, args) => {
    const execFile = vi.fn((_file, _args, _options, callback) => {
      callback(null, "", "");
      return new EventEmitter();
    });
    const adapter = createZellijAdapter({ execFile, timeoutMs: 500 });
    await adapter.paneAction("matrix-rt_0123456789abcdef0123456789abcdef", action as never);
    expect(execFile).toHaveBeenLastCalledWith("zellij", ["--session", "matrix-rt_0123456789abcdef0123456789abcdef", "action", ...args], expect.objectContaining({ timeout: 500 }), expect.any(Function));
  });
  it("defaults to locked mode so editing keys reach applications with an explicit Zellij unlock", () => {
    const config = renderMatrixZellijConfig(matrixZellijConfigPaths("/tmp/terminal-keymap"));
    expect(config).toContain('default_mode "locked"');
    expect(config).toContain('mirror_session true');
    expect(config).toContain('bind "Ctrl g" { SwitchToMode "Normal"; }');
    expect(config).toMatch(/normal\s*\{\s*unbind "Alt Left" "Alt Right" "Alt b" "Alt f"/);
  });
  it("persists validated keyboard preferences and gives old files defaults", () => {
    expect(ShellPreferencesSchema.parse({}).keyboard).toEqual({ profile: "mac", overrides: {} });
    expect(ShellPreferencesPatchSchema.parse({ keyboard: { profile: "passthrough", overrides: {} } }).keyboard?.profile).toBe("passthrough");
    expect(ShellPreferencesPatchSchema.safeParse({ keyboard: { profile: "arbitrary" } }).success).toBe(false);
  });
});

it("fails closed when incarnation-bound actions reach an unmanaged adapter", async () => {
  const execFile = vi.fn();
  const adapter = createZellijAdapter({ execFile: execFile as never, manageConfig: false });
  await expect(adapter.paneAction("main", { type: "close" }, { expectedCreatedAt: "2026-09-01T00:00:00.000Z" })).rejects.toMatchObject({ status: 503 });
  expect(execFile).not.toHaveBeenCalled();
});
