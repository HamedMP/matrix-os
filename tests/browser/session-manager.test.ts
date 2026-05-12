import { describe, expect, it } from "vitest";
import {
  BrowserProfileLockedError,
  BrowserStaleFocusError,
  BrowserStreamLimitError,
  SessionManager,
  type BrowserLike,
  type PageLike,
} from "../../packages/mcp-browser/src/session-manager.js";

function fakePage(): PageLike {
  return {
    async goto() { return null; },
    async title() { return ""; },
    url() { return "about:blank"; },
    async screenshot() { return Buffer.from(""); },
    async pdf() { return Buffer.from(""); },
    async content() { return ""; },
    async evaluate() { return undefined; },
    async click() {},
    async fill() {},
    async selectOption() {},
    getByRole() { return { async click() {} }; },
    async waitForSelector() {},
    async waitForNavigation() {},
    async waitForLoadState() {},
    setDefaultTimeout() {},
    async close() {},
    mouse: { async wheel() {} },
    accessibility: { async snapshot() { return null; } },
    on() {},
    context() { return { pages: () => [this], async newPage() { return fakePage(); }, async close() {} }; },
  };
}

function fakeBrowser(): BrowserLike {
  const page = fakePage();
  return {
    async newPage() { return page; },
    async close() {},
    contexts() {
      return [{ pages: () => [page], async newPage() { return page; }, async close() {} }];
    },
  };
}

describe("Browser SessionManager shared runtime", () => {
  it("allows same-device multiplexing and blocks a second device until takeover", async () => {
    const manager = new SessionManager({ launcher: async () => fakeBrowser() });
    const session = await manager.launch({ profile: "default", deviceId: "device_a" });
    const canvas = manager.attachSurface({ sessionId: session.id, surfaceId: "surface_canvas", deviceId: "device_a", kind: "canvas" });
    const standalone = manager.attachSurface({ sessionId: session.id, surfaceId: "surface_tab", deviceId: "device_a", kind: "standalone" });

    expect(canvas.kind).toBe("canvas");
    expect(standalone.kind).toBe("standalone");
    await expect(manager.launch({ profile: "default", deviceId: "device_b" })).rejects.toBeInstanceOf(BrowserProfileLockedError);

    manager.takeover({ deviceId: "device_b" });
    await expect(manager.launch({ profile: "default", deviceId: "device_b" })).resolves.toBe(session);
  });

  it("enforces focus lease for user input and lets agent actions serialize without focus takeover", async () => {
    const manager = new SessionManager({ launcher: async () => fakeBrowser() });
    const session = await manager.launch({ profile: "default", deviceId: "device_a" });
    manager.attachSurface({ sessionId: session.id, surfaceId: "surface_1", deviceId: "device_a", kind: "canvas" });
    manager.attachSurface({ sessionId: session.id, surfaceId: "surface_2", deviceId: "device_a", kind: "standalone" });
    manager.focusSurface("surface_1");

    await expect(manager.enqueueAction(async () => "ok", { surfaceId: "surface_2" })).rejects.toBeInstanceOf(BrowserStaleFocusError);
    await expect(manager.enqueueAction(async () => "agent", { agent: true })).resolves.toBe("agent");
    expect(manager.getActive()?.focusSurfaceId).toBe("surface_1");
  });

  it("serializes runtime actions in order", async () => {
    const manager = new SessionManager({ launcher: async () => fakeBrowser() });
    const order: string[] = [];
    await manager.launch({ profile: "default", deviceId: "device_a" });

    await Promise.all([
      manager.enqueueAction(async () => {
        order.push("first-start");
        await new Promise((resolve) => setTimeout(resolve, 5));
        order.push("first-end");
      }, { agent: true }),
      manager.enqueueAction(async () => {
        order.push("second");
      }, { agent: true }),
    ]);

    expect(order).toEqual(["first-start", "first-end", "second"]);
  });

  it("rejects queued user input if the surface loses focus before execution", async () => {
    const manager = new SessionManager({ launcher: async () => fakeBrowser() });
    const order: string[] = [];
    const session = await manager.launch({ profile: "default", deviceId: "device_a" });
    manager.attachSurface({ sessionId: session.id, surfaceId: "surface_1", deviceId: "device_a", kind: "canvas" });
    manager.attachSurface({ sessionId: session.id, surfaceId: "surface_2", deviceId: "device_a", kind: "standalone" });
    manager.focusSurface("surface_1");

    let release!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const blocker = manager.enqueueAction(async () => {
      order.push("blocker");
      markStarted();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    }, { agent: true });
    const staleInput = manager.enqueueAction(async () => {
      order.push("stale-input");
    }, { surfaceId: "surface_1" });

    await started;
    manager.focusSurface("surface_2");
    release();

    await blocker;
    await expect(staleInput).rejects.toBeInstanceOf(BrowserStaleFocusError);
    await expect(manager.enqueueAction(async () => "after", { agent: true })).resolves.toBe("after");
    expect(order).toEqual(["blocker"]);
  });

  it("caps multiplexed stream surfaces per live runtime", async () => {
    const manager = new SessionManager({ launcher: async () => fakeBrowser(), maxSurfaces: 2 });
    const session = await manager.launch({ profile: "default", deviceId: "device_a" });

    manager.attachSurface({ sessionId: session.id, surfaceId: "surface_1", deviceId: "device_a", kind: "canvas" });
    manager.attachSurface({ sessionId: session.id, surfaceId: "surface_2", deviceId: "device_a", kind: "standalone" });

    expect(() => manager.attachSurface({
      sessionId: session.id,
      surfaceId: "surface_3",
      deviceId: "device_a",
      kind: "standalone",
    })).toThrow(BrowserStreamLimitError);
  });
});
