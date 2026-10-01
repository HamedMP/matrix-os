import { afterEach, describe, expect, it, vi } from "vitest";
import { NativeAppBridge } from "@desktop/main/embeds/native-app-bridge";
import { createNativeAppOpenResolver } from "@desktop/main/embeds/native-app-open";
import { createNativeAppOpenClient, NATIVE_APP_OPEN_CHANNEL } from "@desktop/shared/native-app-open";

const sender = { id: 1, url: "https://gateway.test/apps/gallery/" };
const request = { name: "Forged display name", path: "/files/apps/planner/index.html" };
const app = { slug: "planner", name: "Planner", appIdentity: "planner" };
function fixture() {
  let generation = 1;
  const resolveApp = vi.fn(async () => app);
  const openApp = vi.fn();
  const bridge = new NativeAppBridge({ authGeneration: () => generation, generate: vi.fn(), aiRequest: vi.fn(), request: vi.fn(),
    gatewayRequest: vi.fn(), gatewayOrigin: () => "https://gateway.test", resolveApp, openApp });
  bridge.register(1, "gallery");
  return { bridge, openApp, resolveApp, advance: () => { generation++; } };
}
afterEach(() => vi.restoreAllMocks());

describe("native installed-app opening", () => {
  it("retains a void launch-request contract and catches asynchronous rejection", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const invoke = vi.fn(async () => { throw new Error("private"); });
    const open = createNativeAppOpenClient(invoke);
    expect(open("Planner", request.path)).toBeUndefined();
    await Promise.resolve();
    expect(invoke).toHaveBeenCalledWith({ name: "Planner", path: request.path });
    expect(warning).toHaveBeenCalledWith("[app-open] App launch is unavailable", "Error");
    expect(() => open("Planner", "https://evil.test")).toThrow("Invalid app launch");
    expect(invoke).toHaveBeenCalledTimes(1);
  });
  it("opens only catalog-resolved metadata from a registered app", async () => {
    const { bridge, openApp, resolveApp } = fixture();
    await bridge.openApp(sender, request);
    expect(resolveApp).toHaveBeenCalledWith(request);
    expect(openApp).toHaveBeenCalledWith(app);
  });
  it.each(["https://evil.test", "//evil.test", "__settings__", "/etc/passwd", "apps/planner/../../system/config.json",
    "apps/planner/%2e%2e/index.html", "apps/planner/src/main.tsx", "apps/planner/index.html?token=forged", "apps/planner\\index.html"])("rejects unsafe destinations before lookup: %s", async (path) => {
    const { bridge, openApp, resolveApp } = fixture();
    await expect(bridge.openApp(sender, { name: "Planner", path })).rejects.toThrow();
    expect(resolveApp).not.toHaveBeenCalled(); expect(openApp).not.toHaveBeenCalled();
  });
  it("rejects forged senders and retired, navigated, or auth-stale app views", async () => {
    const { bridge, resolveApp, advance } = fixture();
    for (const invalid of [{ ...sender, id: 9 }, { ...sender, url: "https://evil.test/apps/gallery/" },
      { ...sender, url: "https://gateway.test/apps/other/" }]) await expect(bridge.openApp(invalid, request)).rejects.toThrow();
    advance(); await expect(bridge.openApp(sender, request)).rejects.toThrow();
    bridge.clear(); await expect(bridge.openApp(sender, request)).rejects.toThrow();
    expect(resolveApp).not.toHaveBeenCalled();
  });
  it.each(["auth", "close", "navigate"])("rejects a pending lookup after %s changes", async (change) => {
    const { bridge, resolveApp, openApp, advance } = fixture();
    let finish!: (value: typeof app) => void;
    resolveApp.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const current = { ...sender };
    const pending = bridge.openApp(current, request);
    if (change === "auth") advance();
    else if (change === "close") bridge.unregister(1);
    else current.url = "https://gateway.test/apps/other/";
    finish(app);
    await expect(pending).rejects.toThrow(); expect(openApp).not.toHaveBeenCalled();
  });
  it("bounds concurrent requests and request frequency, releasing capacity after failure", async () => {
    const { bridge, resolveApp, openApp } = fixture();
    vi.spyOn(Date, "now").mockReturnValue(100_000);
    let finish!: (value: typeof app) => void;
    const deferred = new Promise<typeof app>(resolve => { finish = resolve; });
    resolveApp.mockImplementation(() => deferred);
    const pending = Array.from({ length: 8 }, () => bridge.openApp(sender, request));
    await expect(bridge.openApp(sender, request)).rejects.toThrow("limit");
    finish(app); await Promise.all(pending);
    resolveApp.mockRejectedValueOnce(new Error("offline"));
    await expect(bridge.openApp(sender, request)).rejects.toThrow("offline");
    await bridge.openApp(sender, request);
    await expect(bridge.openApp(sender, request)).rejects.toThrow("limit");
    expect(openApp).toHaveBeenCalledTimes(9);
  });
  it("checks dependencies at registration and blocks subframe IPC without leaking failures", async () => {
    const { bridge, openApp, resolveApp } = fixture();
    const handle = vi.fn(); bridge.registerIpc({ handle });
    const handler = handle.mock.calls.find(([channel]) => channel === NATIVE_APP_OPEN_CHANNEL)![1];
    const frame = {};
    const event = { senderFrame: frame, sender: { id: 1, mainFrame: frame, getURL: () => sender.url, isDestroyed: () => false } };
    await expect(handler({ ...event, senderFrame: {} }, request)).rejects.toThrow(/^App launch is unavailable$/);
    expect(resolveApp).not.toHaveBeenCalled();
    openApp.mockImplementationOnce(() => { throw new Error("private"); });
    await expect(handler(event, request)).rejects.toThrow(/^App launch is unavailable$/);
  });
  it("requires both launch dependencies before registering any launch handler", () => {
    const bridge = new NativeAppBridge({ authGeneration: () => 0, generate: vi.fn(), aiRequest: vi.fn(), request: vi.fn(),
      gatewayRequest: vi.fn(), gatewayOrigin: () => "https://gateway.test", openApp: vi.fn() });
    const handle = vi.fn();
    expect(() => bridge.registerIpc({ handle })).toThrow("dependencies are required");
    expect(handle).not.toHaveBeenCalled();
  });
  it.each(["frame", "destroyed"])("rejects IPC lookup completion after the sender is %s", async (change) => {
    const { bridge, openApp, resolveApp } = fixture();
    let finish!: (value: typeof app) => void;
    resolveApp.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const handle = vi.fn(); bridge.registerIpc({ handle });
    const handler = handle.mock.calls.find(([channel]) => channel === NATIVE_APP_OPEN_CHANNEL)![1];
    const frame = {}; let destroyed = false;
    const webContents = { id: 1, mainFrame: frame, getURL: () => sender.url, isDestroyed: () => destroyed };
    const pending = handler({ senderFrame: frame, sender: webContents }, request);
    if (change === "frame") webContents.mainFrame = {};
    else destroyed = true;
    finish(app);
    await expect(pending).rejects.toThrow(/^App launch is unavailable$/);
    expect(openApp).not.toHaveBeenCalled();
  });
});

describe("installed app catalog resolution", () => {
  it("matches exact installed roots and entries and never trusts the requested name", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify([{ slug: "planner", name: "Planner", file: "planner/index.html", path: "/files/apps/planner/index.html" }])));
    const resolveApp = createNativeAppOpenResolver({ getGatewayOrigin: () => "https://gateway.test", getToken: () => "desktop-token", fetchFn });
    for (const path of ["apps/planner", "~/apps/planner/index.html", "/files/apps/planner/dist/index.html"]) {
      await expect(resolveApp({ name: "Spoofed", path })).resolves.toEqual(app);
    }
    expect(fetchFn).toHaveBeenCalledWith("https://gateway.test/api/apps", expect.objectContaining({ redirect: "error",
      headers: { authorization: "Bearer desktop-token" }, signal: expect.any(AbortSignal) }));
    await expect(resolveApp({ name: "Planner", path: "apps/missing" })).rejects.toThrow();
  });
  it("rejects built-in destinations, unavailable auth, failed and oversized catalog responses", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify([{ slug: "settings", name: "Settings", path: "__settings__" }])));
    const resolveApp = createNativeAppOpenResolver({ getGatewayOrigin: () => "https://gateway.test", getToken: () => "token", fetchFn });
    await expect(resolveApp({ name: "Settings", path: "apps/settings" })).rejects.toThrow();
    fetchFn.mockResolvedValueOnce(new Response("failed", { status: 503 }));
    await expect(resolveApp(request)).rejects.toThrow();
    fetchFn.mockResolvedValueOnce(new Response("[]", { headers: { "content-length": "9000000" } }));
    await expect(resolveApp(request)).rejects.toThrow();
    const signedOut = createNativeAppOpenResolver({ getGatewayOrigin: () => "https://gateway.test", getToken: () => null, fetchFn });
    await expect(signedOut(request)).rejects.toThrow(); expect(fetchFn).toHaveBeenCalledTimes(3);
  });
});
