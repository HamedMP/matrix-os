import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import ts from "typescript";
import { APP_AI_CHANNEL, APP_AI_ROUTES_CHANNEL, APP_CAPABILITY_CHANNEL } from "@matrix-os/contracts";
import { NativeAppBridge, createNativeAppAiRequester } from "@desktop/main/embeds/native-app-bridge";
import { createNativeAppAiRoutesRequester, createNativeAppCapabilityRequester } from "@desktop/main/embeds/native-app-capabilities";
import { EmbedService } from "@desktop/main/embeds/embed-service";

vi.mock("electron", () => ({ net: { request: vi.fn() }, session: { fromPartition: vi.fn() } }));

async function flush() { for (let i = 0; i < 30; i++) await Promise.resolve(); }

// Execute the real composition callback without starting Electron's process.
function authHooks() {
  const source = ts.createSourceFile("index.ts", readFileSync(new URL("../../desktop/src/main/index.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
  let callback = "";
  let binding = "";
  function visit(node: ts.Node): void {
    if (ts.isPropertyAssignment(node) && node.name.getText(source) === "onAuthChanged") callback = node.initializer.getText(source);
    if (ts.isBinaryExpression(node) && node.left.getText(source) === "invalidateAppCapabilities") binding = node.getText(source);
    node.forEachChild(visit);
  }
  visit(source);
  expect(callback).not.toBe("");
  expect(binding).not.toBe("");
  return new Function("navigationCache", "chatgptPlan", "fileDownloads", "organizationDriveTransfers", "localChatImports", "sendEvent", `
    let invalidateAppCapabilities;
    const onAuthChanged = ${callback};
    return { onAuthChanged, bind(nativeAppBridge) { ${binding}; } };
  `)(undefined, undefined, undefined, undefined, undefined, vi.fn()) as {
    onAuthChanged(status: { signedIn: boolean }): void;
    bind(bridge: NativeAppBridge): void;
  };
}

function productionSenderLookup<T>(fromId: (id: number) => T | undefined) {
  const source = ts.createSourceFile("index.ts", readFileSync(new URL("../../desktop/src/main/index.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
  let callback = "";
  function visit(node: ts.Node): void {
    if (ts.isPropertyAssignment(node) && node.name.getText(source) === "getSenderLifecycle") callback = node.initializer.getText(source);
    node.forEachChild(visit);
  }
  visit(source);
  expect(callback).not.toBe("");
  return new Function("webContents", `return ${callback};`)({ fromId }) as (id: number) => T | undefined;
}

function fixture(maxSenders = 64) {
  let generation = 0;
  let origin = "https://old.test";
  const signals: AbortSignal[] = [];
  const cancel = vi.fn();
  const lifetimes = { 1: Object.assign(new EventEmitter(), { isDestroyed: () => false }), 2: Object.assign(new EventEmitter(), { isDestroyed: () => false }) };
  const fetchFn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    signals.push(init!.signal as AbortSignal);
    if (origin === "https://new.test") return Response.json({ routes: [], defaultRoute: null });
    return new Response(new ReadableStream({ cancel }));
  });
  const options = { getGatewayOrigin: () => origin, getToken: () => "synthetic", fetchFn };
  const bridge = new NativeAppBridge({
    authGeneration: () => generation, gatewayOrigin: () => origin, maxSenders,
    generate: vi.fn(), request: vi.fn(), gatewayRequest: vi.fn(),
    capabilityRequest: createNativeAppCapabilityRequester(options), aiRoutesRequest: createNativeAppAiRoutesRequester(options), aiRequest: createNativeAppAiRequester(options),
    getSenderLifecycle: productionSenderLookup((id: number) => lifetimes[id as 1 | 2]),
  });
  const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
  bridge.registerIpc({ handle: (channel, handler) => handlers.set(channel, handler as never) });
  function event(id = 1) {
    const frame = {};
    return { senderFrame: frame, sender: { id, mainFrame: frame, getURL: () => `${origin}/apps/brain/`, isDestroyed: () => false } };
  }
  bridge.register(1, "projects/brain", "brain");
  const embeds = new EmbedService({ getWindow: () => null, getGatewayOrigin: () => origin, getToken: () => "synthetic", emitState: vi.fn(), appBridge: bridge });
  return { bridge, event, handlers, cancel, fetchFn, signals, lifetimes, switchComputer() { embeds.closeAll(); generation++; origin = "https://new.test"; bridge.register(2, "projects/brain", "brain"); } };
}

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe("Electron capability registration cancellation", () => {
  it("fails closed when the production lifetime lookup cannot resolve a live trusted view", () => {
    const f = fixture();
    expect(() => f.bridge.register(3, "projects/brain", "brain")).toThrow("App document is unavailable");
    vi.spyOn(f.lifetimes[1], "isDestroyed").mockReturnValue(true);
    expect(() => f.bridge.register(1, "projects/brain", "brain")).toThrow("App document is unavailable");
    expect(f.lifetimes[1].listenerCount("did-start-navigation")).toBe(0);
    expect(f.fetchFn).not.toHaveBeenCalled();
    f.bridge.clear();
  });
  it("aborts the old main-frame document before reload and admits fresh work with the same trusted identity", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const pending = Array.from({ length: 32 }, (_, i) => f.handlers.get([APP_CAPABILITY_CHANNEL, APP_AI_ROUTES_CHANNEL, APP_AI_CHANNEL][i % 3])!(f.event(), i % 3 === 0 ? { kind: "capabilities" } : i % 3 === 2 ? { prompt: "old document" } : {}).catch(error => error));
    await flush();
    f.lifetimes[1].emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
    await flush();
    expect(f.signals.every(signal => signal.aborted)).toBe(true);
    expect(f.cancel).toHaveBeenCalledTimes(32);
    expect((await Promise.all(pending)).every(value => value instanceof Error)).toBe(true);
    f.fetchFn.mockImplementation(async () => Response.json({ routes: [], defaultRoute: null }));
    await expect(f.handlers.get(APP_AI_ROUTES_CHANNEL)!(f.event(), {})).resolves.toEqual({ routes: [], defaultRoute: null });
    expect(f.fetchFn.mock.calls.at(-1)![0]).toBe("https://old.test/api/bridge/ai/routes?app=projects%2Fbrain");
    f.bridge.clear();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps navigation-cancelled work admitted until actual body cancellation drains", async () => {
    vi.useFakeTimers(); const f = fixture();
    let release!: () => void;
    const drained = new Promise<void>(resolve => { release = resolve; });
    f.cancel.mockImplementation(() => drained);
    const pending = Array.from({ length: 32 }, () => f.handlers.get(APP_AI_CHANNEL)!(f.event(), { prompt: "old document" }).catch(error => error));
    await flush();
    f.lifetimes[1].emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
    await flush();
    expect(f.cancel).toHaveBeenCalledTimes(32);
    await expect(f.handlers.get(APP_AI_ROUTES_CHANNEL)!(f.event(), {})).rejects.toThrow("App AI is unavailable");
    expect(f.fetchFn).toHaveBeenCalledTimes(32);
    release(); await Promise.all(pending);
    f.fetchFn.mockImplementation(async () => Response.json({ routes: [], defaultRoute: null }));
    await expect(f.handlers.get(APP_AI_ROUTES_CHANNEL)!(f.event(), {})).resolves.toEqual({ routes: [], defaultRoute: null });
    f.bridge.clear();
  });

  it("ignores subframes and same-document changes and cleans listeners on replacement, clear and destruction", async () => {
    vi.useFakeTimers(); const f = fixture();
    const pending = f.handlers.get(APP_CAPABILITY_CHANNEL)!(f.event(), { kind: "capabilities" }).catch(error => error);
    await flush();
    f.lifetimes[1].emit("did-start-navigation", { isMainFrame: false, isSameDocument: false });
    f.lifetimes[1].emit("did-start-navigation", { isMainFrame: true, isSameDocument: true });
    expect(f.signals[0].aborted).toBe(false);
    expect(f.lifetimes[1].listenerCount("did-start-navigation")).toBe(1);
    f.bridge.register(1, "projects/brain", "brain");
    expect(f.lifetimes[1].listenerCount("did-start-navigation")).toBe(1);
    expect(await pending).toBeInstanceOf(Error);
    f.lifetimes[1].emit("destroyed");
    expect(f.lifetimes[1].listenerCount("did-start-navigation")).toBe(0);
    expect(f.lifetimes[1].listenerCount("destroyed")).toBe(0);
    f.bridge.register(1, "projects/brain", "brain"); f.bridge.clear();
    expect(f.lifetimes[1].listenerCount("did-start-navigation")).toBe(0);
    expect(f.lifetimes[1].listenerCount("destroyed")).toBe(0);
  });
  it("cancels all old-computer capability/discovery bodies and immediately admits new work", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const pending = Array.from({ length: 32 }, (_, index) => index % 2
      ? f.handlers.get(APP_AI_ROUTES_CHANNEL)!(f.event(), {}).catch(error => error)
      : f.handlers.get(APP_CAPABILITY_CHANNEL)!(f.event(), { kind: "capabilities" }).catch(error => error));
    await flush();
    expect(f.fetchFn).toHaveBeenCalledTimes(32);
    f.switchComputer();
    await flush();
    expect(f.signals.every(signal => signal.aborted)).toBe(true);
    expect(f.cancel).toHaveBeenCalledTimes(32);
    expect((await Promise.all(pending)).every(value => value instanceof Error)).toBe(true);
    await expect(f.handlers.get(APP_AI_ROUTES_CHANNEL)!(f.event(2), {})).resolves.toEqual({ routes: [], defaultRoute: null });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["close", "replace", "evict"] as const)("cancels an in-flight request on registration %s", async (action) => {
    vi.useFakeTimers();
    const f = fixture(1);
    const pending = f.handlers.get(APP_CAPABILITY_CHANNEL)!(f.event(), { kind: "capabilities" }).catch(error => error);
    await flush();
    if (action === "close") f.bridge.unregister(1);
    if (action === "replace") f.bridge.register(1, "other", "brain");
    if (action === "evict") f.bridge.register(2, "projects/brain", "brain");
    await flush();
    expect(f.signals[0].aborted).toBe(true);
    expect(f.cancel).toHaveBeenCalledTimes(1);
    expect(await pending).toBeInstanceOf(Error);
    expect(vi.getTimerCount()).toBe(0);
    f.bridge.clear();
  });

  it("retains pending slots until asynchronous body cancellation actually completes", async () => {
    vi.useFakeTimers();
    const f = fixture();
    let release!: () => void;
    const drained = new Promise<void>(resolve => { release = resolve; });
    f.cancel.mockImplementation(() => drained);
    const pending = Array.from({ length: 32 }, () => f.handlers.get(APP_CAPABILITY_CHANNEL)!(f.event(), { kind: "capabilities" }).catch(error => error));
    await flush();
    f.switchComputer();
    await flush();
    expect(f.cancel).toHaveBeenCalledTimes(32);
    await expect(f.handlers.get(APP_AI_ROUTES_CHANNEL)!(f.event(2), {})).rejects.toThrow("App AI is unavailable");
    expect(f.fetchFn).toHaveBeenCalledTimes(32);
    release();
    await Promise.all(pending);
    await expect(f.handlers.get(APP_AI_ROUTES_CHANNEL)!(f.event(2), {})).resolves.toEqual({ routes: [], defaultRoute: null });
  });

  it("also waits for timed-out body cancellation rather than releasing a slot on the deadline race", async () => {
    vi.useFakeTimers();
    const f = fixture();
    let release!: () => void;
    f.cancel.mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
    let settled = false;
    const pending = f.handlers.get(APP_CAPABILITY_CHANNEL)!(f.event(), { kind: "capabilities" }).catch(error => error).finally(() => { settled = true; });
    await flush();
    await vi.advanceTimersByTimeAsync(35_000);
    expect(f.cancel).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);
    release();
    expect(await pending).toBeInstanceOf(Error);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts network requests before headers when a view closes", async () => {
    vi.useFakeTimers();
    const f = fixture();
    let observed!: AbortSignal;
    f.fetchFn.mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      observed = init!.signal as AbortSignal;
      observed.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    }));
    const pending = f.handlers.get(APP_AI_ROUTES_CHANNEL)!(f.event(), {}).catch(error => error);
    f.bridge.unregister(1);
    expect(observed.aborted).toBe(true);
    expect(await pending).toBeInstanceOf(Error);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels a late response body if transport headers arrive after registration removal", async () => {
    vi.useFakeTimers();
    const f = fixture();
    let headers!: (response: Response) => void;
    f.fetchFn.mockImplementation(() => new Promise(resolve => { headers = resolve; }));
    const pending = f.handlers.get(APP_CAPABILITY_CHANNEL)!(f.event(), { kind: "capabilities" }).catch(error => error);
    f.bridge.unregister(1);
    headers(new Response(new ReadableStream({ cancel: f.cancel })));
    expect(await pending).toBeInstanceOf(Error);
    expect(f.cancel).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not start network work with an already cancelled caller scope", async () => {
    const fetchFn = vi.fn();
    const request = createNativeAppCapabilityRequester({ getGatewayOrigin: () => "https://gateway.test", getToken: () => "synthetic", fetchFn });
    await expect(request("brain", { kind: "capabilities" }, AbortSignal.abort())).rejects.toThrow("App integrations are unavailable");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("uses the real main-process authentication hook to cancel old work and allows a new authenticated registration", async () => {
    vi.useFakeTimers();
    const hooks = authHooks();
    expect(() => hooks.onAuthChanged({ signedIn: false })).not.toThrow();
    const f = fixture();
    hooks.bind(f.bridge);
    const pending = f.handlers.get(APP_CAPABILITY_CHANNEL)!(f.event(), { kind: "capabilities" }).catch(error => error);
    await flush();
    hooks.onAuthChanged({ signedIn: false });
    expect(f.signals[0].aborted).toBe(true);
    expect(await pending).toBeInstanceOf(Error);
    hooks.onAuthChanged({ signedIn: true });
    f.bridge.register(1, "projects/brain", "brain");
    f.fetchFn.mockImplementation(async () => Response.json({ routes: [], defaultRoute: null }));
    await expect(f.handlers.get(APP_AI_ROUTES_CHANNEL)!(f.event(), {})).resolves.toEqual({ routes: [], defaultRoute: null });
  });

  it.each(["close", "auth"] as const)("cancels active AI inference on %s without starting another credential path", async action => {
    vi.useFakeTimers();
    const f = fixture();
    const pending = f.handlers.get(APP_AI_CHANNEL)!(f.event(), { prompt: "Summarize notes" }).catch(error => error);
    await flush();
    if (action === "close") f.bridge.unregister(1);
    else { const hooks = authHooks(); hooks.bind(f.bridge); hooks.onAuthChanged({ signedIn: false }); }
    await flush();
    expect(f.signals[0].aborted).toBe(true);
    expect(f.cancel).toHaveBeenCalledTimes(1);
    expect(await pending).toBeInstanceOf(Error);
    expect(f.fetchFn).toHaveBeenCalledOnce();
    expect(f.fetchFn.mock.calls[0][0]).toBe("https://old.test/api/bridge/ai");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("counts stalled AI inference in the same bounded host budget and releases after actual drain", async () => {
    vi.useFakeTimers();
    const f = fixture();
    let release!: () => void;
    f.cancel.mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
    const pending = f.handlers.get(APP_AI_CHANNEL)!(f.event(), { prompt: "Summarize notes" }).catch(error => error);
    await flush();
    f.bridge.unregister(1);
    await flush();
    expect(f.cancel).toHaveBeenCalledOnce();
    f.bridge.register(2, "projects/brain", "brain");
    const others = Array.from({ length: 31 }, () => f.handlers.get(APP_CAPABILITY_CHANNEL)!(f.event(2), { kind: "capabilities" }).catch(error => error));
    await expect(f.handlers.get(APP_AI_CHANNEL)!(f.event(2), { prompt: "overflow" })).rejects.toThrow("App AI is unavailable");
    expect(f.fetchFn).toHaveBeenCalledTimes(32);
    release();
    await pending;
    // Remaining requests get their own cancellation promises when the scope closes.
    f.cancel.mockImplementation(() => undefined);
    f.bridge.clear();
    await Promise.all(others);
  });
});
