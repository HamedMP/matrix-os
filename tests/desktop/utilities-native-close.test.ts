import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NativeAppBridge } from "@desktop/main/embeds/native-app-bridge";
import { EmbedManager } from "@desktop/main/embeds/embed-manager";

const REQUEST = "native-app:utilities-close-request";
const REPLY = "native-app:utilities-close-reply";
function fixture(identity = "utilities", route = "utilities", ready = true) {
  const handlers = new Map<string, (event: any, value: unknown) => Promise<any>>();
  const lifetime = Object.assign(new EventEmitter(), {
    isDestroyed: () => false, getURL: () => `https://gateway.test/apps/${route}/`, send: vi.fn(),
  });
  let generation = 1;
  const fallback = vi.fn().mockResolvedValue(false);
  const bridge = new NativeAppBridge({
    authGeneration: () => generation, gatewayOrigin: () => "https://gateway.test",
    getSenderLifecycle: () => lifetime, generate: vi.fn(), aiRequest: vi.fn(),
    request: vi.fn(), gatewayRequest: vi.fn(),
    confirmUtilitiesClose: fallback,
  });
  bridge.register(1, identity, route);
  bridge.registerIpc({ handle: (channel: string, handler: any) => handlers.set(channel, handler) });
  const frame = { url: lifetime.getURL() };
  const sender = { id: 1, mainFrame: frame, getURL: lifetime.getURL, isDestroyed: () => false };
  const event = { sender, senderFrame: frame };
  if (ready && identity === "utilities" && route === "utilities" && handlers.has("native-app:utilities-close-ready")) void handlers.get("native-app:utilities-close-ready")!(event, { ready: true });
  return { bridge, lifetime, handlers, fallback, event, changeAuth: () => generation++ };
}
afterEach(() => vi.useRealTimers());
describe("Utilities native document close approval", () => {
  it("waits for the actual registered main frame, retaining work after Keep working", async () => {
    const f = fixture();
    const pending = f.bridge.requestUtilitiesClose(1);
    const [channel, request] = f.lifetime.send.mock.calls[0]!;
    expect(channel).toBe(REQUEST);
    expect(await f.handlers.get(REPLY)!(f.event, { requestId: request.requestId, allow: false })).toEqual({ ok: true });
    expect(await pending).toBe(false);
    f.bridge.clear();
  });
  it("rejects other apps, project identities, wrong routes and unauthenticated generations", async () => {
    for (const [identity, route] of [["notes", "utilities"], ["projects/utilities", "utilities"], ["utilities", "notes"]]) {
      const f = fixture(identity, route);
      expect(await f.bridge.requestUtilitiesClose(1)).toBe(false);
      expect(f.lifetime.send).not.toHaveBeenCalled(); f.bridge.clear();
    }
    const f = fixture(); f.changeAuth();
    expect(await f.bridge.requestUtilitiesClose(1)).toBe(false); f.bridge.clear();
  });
  it("ignores forged, stale and subframe replies and fails closed on timeout", async () => {
    vi.useFakeTimers(); const f = fixture(); const pending = f.bridge.requestUtilitiesClose(1);
    const request = f.lifetime.send.mock.calls[0]![1];
    await expect(f.handlers.get(REPLY)!({ ...f.event, senderFrame: { url: f.lifetime.getURL() } }, { requestId: request.requestId, allow: true })).rejects.toThrow();
    await expect(f.handlers.get(REPLY)!(f.event, { requestId: "00000000-0000-4000-8000-000000000000", allow: true })).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(60_000); expect(await pending).toBe(false);
    await expect(f.handlers.get(REPLY)!(f.event, { requestId: request.requestId, allow: true })).rejects.toThrow();
    f.bridge.clear(); expect(vi.getTimerCount()).toBe(0);
  });
  it.each(["navigation", "destroy", "auth"])("cannot approve a changed document after %s", async change => {
    const f = fixture(); const pending = f.bridge.requestUtilitiesClose(1);
    const request = f.lifetime.send.mock.calls[0]![1];
    if (change === "navigation") f.lifetime.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
    else if (change === "destroy") f.lifetime.emit("destroyed");
    else f.changeAuth();
    await expect(f.handlers.get(REPLY)!(f.event, { requestId: request.requestId, allow: true })).rejects.toThrow();
    f.bridge.clear(); expect(await pending).toBe(false);
  });
  it("coalesces concurrent closes without retaining an unbounded request registry", async () => {
    const f = fixture(); const first = f.bridge.requestUtilitiesClose(1); const second = f.bridge.requestUtilitiesClose(1);
    expect(f.lifetime.send).toHaveBeenCalledTimes(1);
    const request = f.lifetime.send.mock.calls[0]![1];
    await f.handlers.get(REPLY)!(f.event, { requestId: request.requestId, allow: true });
    expect(await first).toBe(true); expect(await second).toBe(true); f.bridge.clear();
  });
  it("uses explicit native confirmation for an unavailable app and retains it on Keep working", async () => {
    const f = fixture("utilities", "utilities", false);
    expect(await f.bridge.requestUtilitiesClose(1)).toBe(false);
    expect(f.fallback).toHaveBeenCalledTimes(1); expect(f.lifetime.send).not.toHaveBeenCalled();
    f.fallback.mockResolvedValue(true);
    expect(await f.bridge.requestUtilitiesClose(1)).toBe(true); f.bridge.clear();
  });
  it("does not turn Keep working from the app into a second native confirmation", async () => {
    const f = fixture(); const pending = f.bridge.requestUtilitiesClose(1);
    await f.handlers.get(REPLY)!(f.event, { requestId: f.lifetime.send.mock.calls[0]![1].requestId, allow: false });
    expect(await pending).toBe(false); expect(f.fallback).not.toHaveBeenCalled(); f.bridge.clear();
  });
  it("cancels stale parent confirmation on navigation and coalesces concurrent unavailable closes", async () => {
    const f = fixture("utilities", "utilities", false); let resolve!: (allow: boolean) => void;
    let signal!: AbortSignal;
    f.fallback.mockImplementation((scope: AbortSignal) => { signal = scope; return new Promise<boolean>(done => { resolve = done; }); });
    const first = f.bridge.requestUtilitiesClose(1); const second = f.bridge.requestUtilitiesClose(1);
    expect(f.fallback).toHaveBeenCalledTimes(1);
    f.lifetime.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
    expect(signal.aborted).toBe(true); resolve(true);
    expect(await first).toBe(false); expect(await second).toBe(false); f.bridge.clear();
  });
});

describe("native view disposal", () => {
  it("keeps the same attached view until approval and destroys it only after confirmation", async () => {
    let settle!: (allow: boolean) => void;
    const view = { setBounds: vi.fn(), setScale: vi.fn(), loadUrl: vi.fn().mockResolvedValue(undefined), attach: vi.fn(), detach: vi.fn(), destroy: vi.fn(), requestClose: () => new Promise<boolean>(resolve => { settle = resolve; }) };
    const manager = new EmbedManager({ createView: () => view, allowedOrigins: ["https://gateway.test"] });
    const id = manager.open("app", "utilities", { x: 0, y: 0, width: 500, height: 500 }, "https://gateway.test/apps/utilities/", { allowedOrigins: ["https://gateway.test"] });
    const retained = manager.requestClose(id);
    expect(view.destroy).not.toHaveBeenCalled(); expect(view.detach).not.toHaveBeenCalled();
    settle(false); expect(await retained).toBe(false); expect(view.destroy).not.toHaveBeenCalled();
    const confirmed = manager.requestClose(id); settle(true); expect(await confirmed).toBe(true);
    expect(view.destroy).toHaveBeenCalledTimes(1);
  });
});
