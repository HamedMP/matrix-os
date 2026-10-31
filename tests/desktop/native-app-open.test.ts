import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { NativeAppBridge } from "@desktop/main/embeds/native-app-bridge";
import { createNativeAppOpenResolver } from "@desktop/main/embeds/native-app-open";
import { createNativeAppChatNavigationBroker } from "@desktop/main/embeds/native-app-chat-navigation";
import { createNativeAppOpenClient, NATIVE_APP_OPEN_CHANNEL } from "@desktop/shared/native-app-open";
import { createNativeAppOpenChatClient, NATIVE_APP_OPEN_CHAT_CHANNEL } from "@desktop/shared/native-app-chat";

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
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("acknowledged native Chat navigation", () => {
  it("records a safe diagnostic when renderer delivery fails", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const broker = createNativeAppChatNavigationBroker({ emit: () => { throw new TypeError("private renderer detail"); } });
    await expect(broker.request({ view: "recipes" }, { runtimeSlot: "primary", authGeneration: 4 }))
      .rejects.toThrow("could not be delivered");
    expect(warning).toHaveBeenCalledWith("[native-app-chat] delivery failed:", "TypeError");
  });
  it("resolves only the matching renderer acknowledgement and bounds pending requests", async () => {
    const emit = vi.fn();
    const broker = createNativeAppChatNavigationBroker({ emit });
    const pending = broker.request({ view: "recipes", recipeId: "company-brain" }, { runtimeSlot: "primary", authGeneration: 4 });
    const event = emit.mock.calls[0]![0];
    expect(event).toMatchObject({ view: "recipes", recipeId: "company-brain", runtimeSlot: "primary", authGeneration: 4 });
    expect(() => broker.complete({ requestId: "wrong", ok: true })).toThrow("Unknown Chat navigation request");
    await expect(broker.request({ view: "recipes" }, { runtimeSlot: "primary", authGeneration: 4 })).rejects.toThrow("busy");
    broker.complete({ requestId: event.requestId, ok: true });
    await expect(pending).resolves.toBeUndefined();
  });

  it("rejects unavailable recipes, lifecycle cancellation, and timeouts", async () => {
    vi.useFakeTimers();
    const emit = vi.fn();
    const broker = createNativeAppChatNavigationBroker({ emit, timeoutMs: 1_000 });
    const unavailable = broker.request({ view: "recipes", recipeId: "missing" }, { runtimeSlot: "primary", authGeneration: 4 });
    broker.complete({ requestId: emit.mock.calls[0]![0].requestId, ok: false, error: "recipe_unavailable" });
    await expect(unavailable).rejects.toThrow("failed");
    const canceled = broker.request({ view: "recipes" }, { runtimeSlot: "primary", authGeneration: 4 });
    broker.cancelAll();
    await expect(canceled).rejects.toThrow("canceled");
    const timedOut = broker.request({ view: "recipes" }, { runtimeSlot: "primary", authGeneration: 4 });
    const timedOutExpectation = expect(timedOut).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(1_000);
    await timedOutExpectation;
  });

  it("removes a queued renderer request when its app-document authority aborts", async () => {
    const cancel = vi.fn();
    const broker = createNativeAppChatNavigationBroker({ emit: vi.fn(), cancel, timeoutMs: 1_000 });
    const controller = new AbortController();
    const pending = broker.request(
      { view: "recipes", recipeId: "company-brain" },
      { runtimeSlot: "primary", authGeneration: 4 },
      controller.signal,
    );
    try {
      controller.abort();
      expect(cancel).toHaveBeenCalledWith(expect.objectContaining({ requestId: expect.stringMatching(/^chat_/) }));
      await expect(pending).rejects.toThrow("canceled");
    } finally {
      broker.cancelAll();
      await pending.catch(() => undefined);
    }
  });
});

describe("native installed-app opening", () => {
  it("keeps Chat recipe navigation out of the installed-app path contract", async () => {
    const invoke = vi.fn(async () => ({ ok: true }));
    const openChat = createNativeAppOpenChatClient(invoke);
    await expect(openChat({ view: "recipes", recipeId: "company-brain" })).resolves.toBeUndefined();
    expect(invoke).toHaveBeenCalledWith({ view: "recipes", recipeId: "company-brain" });
    await expect(openChat({ view: "library" } as never)).rejects.toThrow("Invalid Chat navigation");
    await expect(openChat({ view: "recipes", recipeId: "../company-brain" })).rejects.toThrow("Invalid Chat navigation");
    expect(invoke).toHaveBeenCalledTimes(1);
  });
  it("records a safe app-side diagnostic while keeping invocation failures generic", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const openChat = createNativeAppOpenChatClient(vi.fn(async () => { throw new TypeError("private bridge detail"); }));
    await expect(openChat({ view: "recipes" })).rejects.toThrow("Chat navigation is unavailable");
    expect(warning).toHaveBeenCalledWith("[native-app-chat] invocation failed:", "TypeError");
  });
  it("acknowledges authorized Chat recipe navigation and returns generic failures", async () => {
    const openChat = vi.fn(async () => undefined);
    const f = fixture();
    const bridge = new NativeAppBridge({
      authGeneration: () => 1, generate: vi.fn(), aiRequest: vi.fn(), request: vi.fn(), gatewayRequest: vi.fn(),
      gatewayOrigin: () => "https://gateway.test", resolveApp: f.resolveApp, openApp: f.openApp, openChat,
    });
    bridge.register(1, "gallery");
    await bridge.openChat(sender, { view: "recipes", recipeId: "company-brain" });
    expect(openChat).toHaveBeenCalledWith({ view: "recipes", recipeId: "company-brain" }, expect.any(AbortSignal));
    expect(f.resolveApp).not.toHaveBeenCalled();

    const handle = vi.fn(); bridge.registerIpc({ handle });
    const handler = handle.mock.calls.find(([channel]) => channel === NATIVE_APP_OPEN_CHAT_CHANNEL)![1];
    const frame = {};
    const event = { senderFrame: frame, sender: { id: 1, mainFrame: frame, getURL: () => sender.url, isDestroyed: () => false } };
    openChat.mockRejectedValueOnce(new Error("private catalog detail"));
    await expect(handler(event, { view: "recipes", recipeId: "missing" })).rejects.toThrow(/^Chat navigation is unavailable$/);
  });
  it.each(["navigation", "destruction"] as const)("cancels queued Chat navigation on app-document %s", async change => {
    const lifetime = Object.assign(new EventEmitter(), { isDestroyed: () => false });
    const cancel = vi.fn();
    const broker = createNativeAppChatNavigationBroker({ emit: vi.fn(), cancel, timeoutMs: 1_000 });
    const bridge = new NativeAppBridge({
      authGeneration: () => 1, generate: vi.fn(), aiRequest: vi.fn(), request: vi.fn(), gatewayRequest: vi.fn(),
      gatewayOrigin: () => "https://gateway.test", getSenderLifecycle: () => lifetime,
      openChat: (chatRequest, signal) => broker.request(chatRequest, { runtimeSlot: "primary", authGeneration: 1 }, signal),
    });
    bridge.register(1, "gallery");
    const pending = bridge.openChat(sender, { view: "recipes", recipeId: "company-brain" });
    try {
      if (change === "navigation") lifetime.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
      else lifetime.emit("destroyed");
      expect(cancel).toHaveBeenCalledWith(expect.objectContaining({ requestId: expect.stringMatching(/^chat_/) }));
      await expect(pending).rejects.toThrow();
    } finally {
      broker.cancelAll();
      bridge.clear();
      await pending.catch(() => undefined);
    }
  });
  it.each([["matrix-browser", "Browser"], ["matrix-cloud-desktop", "Cloud desktop"]])("opens fixed %s aliases only from a product sender", async (appIdentity, name) => {
    const f = fixture(); f.bridge.register(1, "matrix-browser", "browser-lab");
    await f.bridge.openApp({ id: 1, url: "https://gateway.test/apps/browser-lab/?surface=browser" }, { name: "ignored", path: `matrix-app:${appIdentity}` });
    expect(f.resolveApp).not.toHaveBeenCalled();
    expect(f.openApp).toHaveBeenCalledWith({ slug: "browser-lab", appIdentity, name });
  });
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
    "apps/planner/%2e%2e/index.html", "apps/planner/index.html?token=forged", "apps/planner\\index.html"])("rejects unsafe destinations before lookup: %s", async (path) => {
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
  it("keeps launch rate budgets independent across registered senders and authentication generations", async () => {
    const { bridge, openApp, advance } = fixture();
    const now = vi.spyOn(Date, "now").mockReturnValue(100_000);
    bridge.register(2, "other-app");
    for (let index = 0; index < 10; index++) await bridge.openApp(sender, request);
    await expect(bridge.openApp(sender, request)).rejects.toThrow("limit");
    await bridge.openApp({ id: 2, url: "https://gateway.test/apps/other-app/" }, request);
    expect(openApp).toHaveBeenCalledTimes(11);
    advance();
    await expect(bridge.openApp(sender, request)).rejects.toThrow("not authorized");
    bridge.register(1, "gallery");
    await bridge.openApp(sender, request);
    expect(openApp).toHaveBeenCalledTimes(12);
    now.mockReturnValue(160_000);
    for (let index = 0; index < 10; index++) await bridge.openApp(sender, request);
    await expect(bridge.openApp(sender, request)).rejects.toThrow("limit");
    bridge.clear(); bridge.register(1, "gallery");
    await bridge.openApp(sender, request);
    expect(openApp).toHaveBeenCalledTimes(23);
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
    for (const path of ["apps/missing", "apps/planner/src/main.tsx"]) {
      await expect(resolveApp({ name: "Planner", path })).rejects.toThrow();
    }
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


describe("manifest-backed moved owner app launch", () => {
  it.each(["apps/renamed-ledger", "apps/finance/renamed-ledger", "apps/My Finance/Owner Ledger"])("opens %s through the registered bridge and catalog resolver", async (path) => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify([{ slug: "folio", name: "Owner Ledger", path: `/files/${path}/index.html`, launchUrl: "/apps/folio/" }])));
    const resolver = createNativeAppOpenResolver({ getGatewayOrigin: () => "https://gateway.test", getToken: () => "owner-token", fetchFn });
    const openApp = vi.fn();
    const bridge = new NativeAppBridge({ authGeneration: () => 1, generate: vi.fn(), aiRequest: vi.fn(), request: vi.fn(), gatewayRequest: vi.fn(), gatewayOrigin: () => "https://gateway.test", resolveApp: resolver, openApp });
    bridge.register(1, "gallery");
    for (const entry of [path, `${path}/index.html`, `${path}/dist/index.html`, "apps/folio"]) {
      await bridge.openApp(sender, { name: "Forged", path: entry });
    }
    expect(openApp).toHaveBeenCalledTimes(4);
    expect(openApp).toHaveBeenLastCalledWith({ slug: "folio", name: "Owner Ledger", appIdentity: "folio" });
    await expect(bridge.openApp(sender, { name: "Other", path: "apps/not-installed" })).rejects.toThrow();
    expect(openApp).toHaveBeenCalledTimes(4);
  });
});


describe("explicit manifest launch identities", () => {
  const catalog = [
    { slug: "folio", name: "Folio", path: "/files/apps/ledger/index.html" },
    { slug: "ledger", name: "Ledger", path: "/files/apps/folio/index.html" },
  ];
  it("opens the manifest identity despite another app occupying its old folder, while retaining folder launches", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify(catalog)));
    const resolveApp = createNativeAppOpenResolver({ getGatewayOrigin: () => "https://gateway.test", getToken: () => "owner-token", fetchFn });
    const openApp = vi.fn();
    const bridge = new NativeAppBridge({ authGeneration: () => 1, generate: vi.fn(), aiRequest: vi.fn(), request: vi.fn(), gatewayRequest: vi.fn(), gatewayOrigin: () => "https://gateway.test", resolveApp, openApp });
    bridge.register(1, "gallery");
    const open = createNativeAppOpenClient(value => bridge.openApp(sender, value));
    open("Forged", "matrix-app:folio");
    await vi.waitFor(() => expect(openApp).toHaveBeenCalledWith({ slug: "folio", name: "Folio", appIdentity: "folio" }));
    await bridge.openApp(sender, { name: "Forged", path: "apps/folio" });
    expect(openApp).toHaveBeenLastCalledWith({ slug: "ledger", name: "Ledger", appIdentity: "ledger" });
  });
  it.each(["matrix-app:missing", "matrix-app:../folio", "matrix-app:folio?x", "matrix-app:folio/other", "matrix-app://folio"])("keeps invalid or unavailable identity %s closed", async path => {
    const resolveApp = createNativeAppOpenResolver({ getGatewayOrigin: () => "https://gateway.test", getToken: () => "owner-token", fetchFn: vi.fn(async () => new Response(JSON.stringify(catalog))) });
    await expect(resolveApp({ name: "Forged", path })).rejects.toThrow();
  });
  it("keeps duplicate manifest identities closed instead of picking one owner folder", async () => {
    const resolveApp = createNativeAppOpenResolver({ getGatewayOrigin: () => "https://gateway.test", getToken: () => "owner-token", fetchFn: vi.fn(async () => new Response(JSON.stringify([catalog[0], { ...catalog[0], path: "/files/apps/duplicate/index.html" }]))) });
    await expect(resolveApp({ name: "Forged", path: "matrix-app:folio" })).rejects.toThrow();
  });
});

describe("bounded long owner paths with explicit manifest identities", () => {
  const ownerRoot = "apps/" + Array.from({ length: 16 }, () => "a".repeat(250)).join("/");
  const row = { slug: "folio", name: "Owner Folio", path: `/files/${ownerRoot}/index.html` };
  const resolver = (rows: unknown[]) => createNativeAppOpenResolver({ getGatewayOrigin: () => "https://gateway.test", getToken: () => "token", fetchFn: vi.fn(async () => new Response(JSON.stringify(rows))) });
  it.each([2049, 4096])("opens a supported %s-character catalog root through its manifest identity", async length => {
    const components = Array.from({ length: 16 }, (_, index) => "a".repeat(Math.floor((length - 20) / 16) + (index < (length - 20) % 16 ? 1 : 0)));
    const root = "apps/" + components.join("/");
    expect(root.length).toBe(length);
    await expect(resolver([{ ...row, path: `/files/${root}/index.html` }])({ name: "Forged", path: "matrix-app:folio" })).resolves.toEqual({ slug: "folio", name: "Owner Folio", appIdentity: "folio" });
  });
  it("counts long-folder duplicate identities before allowing a short-folder launch", async () => {
    await expect(resolver([{ ...row, path: "/files/apps/short/index.html" }, row])({ name: "Forged", path: "matrix-app:folio" })).rejects.toThrow("installed app unavailable");
  });
  it.each(["apps/../owner", "apps/owner%2fsecret", "apps/owner\\secret", "apps/owner?secret", "apps/" + "a".repeat(4096)])("rejects unsafe or oversized catalog roots: %s", async root => {
    await expect(resolver([{ ...row, path: `/files/${root}/index.html` }])({ name: "Forged", path: "matrix-app:folio" })).rejects.toThrow("installed app unavailable");
  });
});
