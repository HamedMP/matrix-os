import { describe, expect, it } from "vitest";
import {
  BrowserRuntimeService,
  browserAutomationDefaultArgs,
  readBrowserHumanContextOptions,
} from "../../packages/mcp-browser/src/runtime-service.js";
import type { BrowserLike, PageLike } from "../../packages/mcp-browser/src/session-manager.js";

type RouteHandler = (route: { request(): { url(): string }; continue(): Promise<void>; abort(errorCode?: string): Promise<void> }) => Promise<void> | void;

function fakePage(): PageLike & { __routes: RouteHandler[] } {
  let currentUrl = "about:blank";
  const routes: RouteHandler[] = [];
  return {
    async goto(url: string) {
      currentUrl = url;
      return null;
    },
    async title() { return ""; },
    url() { return currentUrl; },
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
    context() { return { pages: () => [this], async newPage() { return fakePage(); }, async close() {}, async route(_url, handler) { routes.push(handler); } }; },
    __routes: routes,
  };
}

function fakePageWithFailingGoto(): PageLike & { __routes: RouteHandler[] } {
  const page = fakePage();
  return {
    ...page,
    async goto(_url: string) {
      throw new Error("page.goto: Timeout 30000ms exceeded.");
    },
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

function fakeBrowserWithClosedInitialPage(): BrowserLike {
  const closedPage = {
    ...fakePage(),
    isClosed() { return true; },
    async screenshot() { throw new Error("page closed"); },
  };
  const livePage = fakePage();
  return {
    async newPage() { return livePage; },
    contexts() {
      return [{
        pages: () => [closedPage],
        async newPage() { return livePage; },
        async close() {},
      }];
    },
    async close() {},
  };
}

function fakeBrowserWithCdpScreenshot(): BrowserLike {
  let context: ReturnType<PageLike["context"]>;
  const page = {
    ...fakePage(),
    context() { return context; },
  };
  context = {
    pages: () => [page],
    async newPage() { return page; },
    async close() {},
    async newCDPSession() {
      return {
        async send(method: string) {
          if (method !== "Page.captureScreenshot") throw new Error("unexpected method");
          return { data: Buffer.from("jpeg").toString("base64") };
        },
      };
    },
  };
  return {
    async newPage() { return page; },
    contexts() { return [context]; },
    async close() {},
  };
}

function fakeBrowserWithInputRecorder(events: string[]): BrowserLike {
  const page = {
    ...fakePage(),
    mouse: {
      async move(x: number, y: number) { events.push(`move:${x}:${y}`); },
      async down(opts?: { button?: "left" | "middle" | "right" }) { events.push(`down:${opts?.button ?? "left"}`); },
      async up(opts?: { button?: "left" | "middle" | "right" }) { events.push(`up:${opts?.button ?? "left"}`); },
      async wheel(deltaX: number, deltaY: number) { events.push(`wheel:${deltaX}:${deltaY}`); },
    },
    keyboard: {
      async insertText(text: string) { events.push(`text:${text}`); },
      async press(key: string) { events.push(`press:${key}`); },
      async up(key: string) { events.push(`key-up:${key}`); },
    },
  };
  return {
    async newPage() { return page; },
    contexts() {
      return [{ pages: () => [page], async newPage() { return page; }, async close() {} }];
    },
    async close() {},
  };
}

describe("BrowserRuntimeService", () => {
  it("uses stable human-operated desktop context defaults", () => {
    expect(readBrowserHumanContextOptions({} as NodeJS.ProcessEnv)).toEqual({
      viewport: { width: 1365, height: 768 },
      screen: { width: 1365, height: 768 },
      locale: "en-US",
      extraHTTPHeaders: { "Accept-Language": "en-US,en;q=0.9" },
      colorScheme: "light",
      serviceWorkers: "allow",
    });
    expect(readBrowserHumanContextOptions({
      BROWSER_VIEWPORT_WIDTH: "1440",
      BROWSER_VIEWPORT_HEIGHT: "900",
      BROWSER_LOCALE: "de-DE",
      BROWSER_TIMEZONE_ID: "Europe/Berlin",
    } as NodeJS.ProcessEnv)).toMatchObject({
      viewport: { width: 1440, height: 900 },
      locale: "de-DE",
      timezoneId: "Europe/Berlin",
      extraHTTPHeaders: { "Accept-Language": "de-DE,de;q=0.9" },
    });
  });

  it("removes Chromium's automation banner default arg without disabling scripts or service workers", () => {
    expect(browserAutomationDefaultArgs()).toEqual(["--enable-automation"]);
  });

  it("tracks bounded tabs and records navigation state", async () => {
    const runtime = new BrowserRuntimeService({
      launcher: async () => fakeBrowser(),
      profileRoot: "/tmp/browser-profiles",
      limits: { maxTabs: 2 },
      resolveHostname: async () => ["93.184.216.34"],
    });

    await runtime.open({ profile: "default", deviceId: "device_1" });
    runtime.createTab({ url: "about:blank" });
    runtime.createTab({ url: "https://example.com/" });

    expect(() => runtime.createTab()).toThrow("browser_tab_limit_reached");
    expect(runtime.listTabs()).toHaveLength(2);
    await runtime.prepareNavigation("https://example.com/old");
    await expect(runtime.navigate("https://example.com/docs")).resolves.toMatchObject({
      currentUrl: "https://example.com/docs",
      state: "active",
      tabs: expect.arrayContaining([expect.objectContaining({ url: "https://example.com/docs" })]),
    });
    expect(runtime.listTabs()).toEqual([
      expect.objectContaining({ url: "about:blank" }),
      expect.objectContaining({ url: "https://example.com/docs" }),
    ]);
  });

  it("checks runtime requests against the active navigation policy", async () => {
    const page = fakePage();
    const runtime = new BrowserRuntimeService({
      launcher: async () => ({
        async newPage() { return page; },
        async close() {},
        contexts() {
          return [{ pages: () => [page], async newPage() { return page; }, async close() {}, async route(_url, handler) { page.__routes.push(handler); } }];
        },
      }),
      profileRoot: "/tmp/browser-profiles",
      resolveHostname: async (hostname) => hostname === "example.com" ? ["93.184.216.34"] : ["10.0.0.2"],
    });

    await runtime.open({ profile: "default", deviceId: "device_1" });
    await runtime.navigate("https://example.com/docs");

    const outcomes: string[] = [];
    const handler = page.__routes[0];
    expect(handler).toBeDefined();
    await handler?.({
      request: () => ({ url: () => "https://example.com/asset.js" }),
      continue: async () => { outcomes.push("continue"); },
      abort: async () => { outcomes.push("abort"); },
    });
    await handler?.({
      request: () => ({ url: () => "https://internal.example/secret" }),
      continue: async () => { outcomes.push("continue"); },
      abort: async () => { outcomes.push("abort"); },
    });

    expect(outcomes).toEqual(["continue", "abort"]);
  });

  it("keeps the runtime session active when Chromium navigation times out", async () => {
    const page = fakePageWithFailingGoto();
    const runtime = new BrowserRuntimeService({
      launcher: async () => ({
        async newPage() { return page; },
        async close() {},
        contexts() {
          return [{ pages: () => [page], async newPage() { return page; }, async close() {}, async route(_url, handler) { page.__routes.push(handler); } }];
        },
      }),
      profileRoot: "/tmp/browser-profiles",
      resolveHostname: async () => ["93.184.216.34"],
    });

    await runtime.open({ profile: "default", deviceId: "device_1" });

    await expect(runtime.navigate("https://example.com/docs")).resolves.toMatchObject({
      currentUrl: "about:blank",
      state: "active",
      tabs: expect.arrayContaining([expect.objectContaining({ url: "https://example.com/docs" })]),
    });
  });

  it("pins Chromium DNS resolution to the active navigation policy", async () => {
    const launchArgs: string[][] = [];
    const runtime = new BrowserRuntimeService({
      launcher: async (opts) => {
        launchArgs.push(opts?.args ?? []);
        return fakeBrowser();
      },
      profileRoot: "/tmp/browser-profiles",
      resolveHostname: async (hostname) => hostname === "example.com" ? ["93.184.216.34"] : ["93.184.216.35"],
    });

    await runtime.open({ profile: "default", deviceId: "device_1" });
    await runtime.navigate("https://example.com/docs");
    await runtime.navigate("https://other.example/docs");

    expect(launchArgs[1]).toContain("--host-resolver-rules=MAP example.com 93.184.216.34");
    expect(launchArgs[2]).toContain("--host-resolver-rules=MAP other.example 93.184.216.35");
  });

  it("enforces session, stream, memory, disk, and download limits", async () => {
    const runtime = new BrowserRuntimeService({
      launcher: async () => fakeBrowser(),
      profileRoot: "/tmp/browser-profiles",
      limits: {
        maxDownloads: 1,
        maxMemoryBytes: 1024,
        maxProfileBytes: 2048,
        maxStreams: 2,
        maxSessions: 1,
      },
      resolveHostname: async () => ["93.184.216.34"],
    });

    runtime.assertOwnerLimits({ sessions: 0, streams: 1, memoryBytes: 1024, profileBytes: 2048 });
    expect(() => runtime.assertOwnerLimits({ sessions: 1 })).toThrow("browser_session_limit_reached");
    expect(() => runtime.assertOwnerLimits({ streams: 2 })).toThrow("browser_stream_limit_reached");
    expect(() => runtime.assertOwnerLimits({ memoryBytes: 1025 })).toThrow("browser_memory_limit_reached");
    expect(() => runtime.assertOwnerLimits({ profileBytes: 2049 })).toThrow("browser_disk_limit_reached");

    const download = runtime.createDownload({ filename: "report.pdf", now: 1000 });
    expect(download).toMatchObject({ filename: "report.pdf", state: "staged" });
    expect(() => runtime.createDownload({ filename: "extra.pdf" })).toThrow("browser_download_limit_reached");
    expect(runtime.completeDownload(download.id, 2000)).toMatchObject({ state: "complete" });
    expect(runtime.failDownload(download.id, 3000)).toMatchObject({ state: "failed" });
    expect(runtime.listDownloads()).toHaveLength(1);
  });

  it("allows reopening the active runtime while enforcing the new-session cap", async () => {
    const runtime = new BrowserRuntimeService({
      launcher: async () => fakeBrowser(),
      profileRoot: "/tmp/browser-profiles",
      limits: { maxSessions: 1 },
      resolveHostname: async () => ["93.184.216.34"],
    });

    await expect(runtime.open({ profile: "default", deviceId: "device_1" })).resolves.toMatchObject({
      state: "active",
    });
    await expect(runtime.open({ profile: "default", deviceId: "device_1" })).resolves.toMatchObject({
      state: "active",
    });

    const disabledRuntime = new BrowserRuntimeService({
      launcher: async () => fakeBrowser(),
      profileRoot: "/tmp/browser-profiles",
      limits: { maxSessions: 0 },
      resolveHostname: async () => ["93.184.216.34"],
    });
    await expect(disabledRuntime.open({ profile: "default", deviceId: "device_1" })).rejects.toThrow(
      "browser_session_limit_reached",
    );
  });

  it("binds the runtime session id to the gateway session id", async () => {
    const runtime = new BrowserRuntimeService({
      launcher: async () => fakeBrowser(),
      profileRoot: "/tmp/browser-profiles",
      resolveHostname: async () => ["93.184.216.34"],
    });

    await expect(runtime.open({
      profile: "default",
      deviceId: "device_1",
      sessionId: "browser_session_1",
    })).resolves.toMatchObject({
      id: "browser_session_1",
    });
    await expect(runtime.navigateSession("browser_session_1", "https://example.com/docs")).resolves.toMatchObject({
      currentUrl: "https://example.com/docs",
    });
  });

  it("recovers a closed page before capturing fallback frames", async () => {
    const runtime = new BrowserRuntimeService({
      launcher: async () => fakeBrowserWithClosedInitialPage(),
      profileRoot: "/tmp/browser-profiles",
      resolveHostname: async () => ["93.184.216.34"],
    });

    await runtime.open({
      profile: "default",
      deviceId: "device_1",
      sessionId: "browser_session_1",
    });

    await expect(runtime.captureFrame("browser_session_1")).resolves.toMatchObject({
      sessionId: "browser_session_1",
      mimeType: "image/jpeg",
    });
  });

  it("captures fallback frames through CDP when available", async () => {
    const runtime = new BrowserRuntimeService({
      launcher: async () => fakeBrowserWithCdpScreenshot(),
      profileRoot: "/tmp/browser-profiles",
      resolveHostname: async () => ["93.184.216.34"],
    });

    await runtime.open({
      profile: "default",
      deviceId: "device_1",
      sessionId: "browser_session_1",
    });

    await expect(runtime.captureFrame("browser_session_1")).resolves.toMatchObject({
      data: Buffer.from("jpeg").toString("base64"),
      mimeType: "image/jpeg",
    });
  });

  it("applies pointer and keyboard input to the live page", async () => {
    const events: string[] = [];
    const runtime = new BrowserRuntimeService({
      launcher: async () => fakeBrowserWithInputRecorder(events),
      profileRoot: "/tmp/browser-profiles",
      resolveHostname: async () => ["93.184.216.34"],
    });

    await runtime.open({
      profile: "default",
      deviceId: "device_1",
      sessionId: "browser_session_1",
    });
    await runtime.applyInput("browser_session_1", {
      type: "input.pointer",
      payload: { kind: "down", x: 42, y: 64, button: "left", modifiers: [] },
    });
    await runtime.applyInput("browser_session_1", {
      type: "input.pointer",
      payload: { kind: "wheel", x: 42, y: 64, button: "none", deltaX: 1, deltaY: 2, modifiers: [] },
    });
    await runtime.applyInput("browser_session_1", {
      type: "input.keyboard",
      payload: { kind: "keydown", key: "a", code: "KeyA", text: "a", modifiers: [] },
    });
    await runtime.applyInput("browser_session_1", {
      type: "input.paste",
      payload: { text: "hello" },
    });

    expect(events).toEqual(["move:42:64", "down:left", "move:42:64", "wheel:1:2", "text:a", "text:hello"]);
  });

  it("hibernates idle sessions and restores saved tab URLs on reopen", async () => {
    const runtime = new BrowserRuntimeService({
      launcher: async () => fakeBrowser(),
      profileRoot: "/tmp/browser-profiles",
      limits: { idleMs: 10 },
      resolveHostname: async () => ["93.184.216.34"],
    });

    await runtime.open({ profile: "default", deviceId: "device_1" });
    runtime.createTab({ url: "https://example.com/" });
    const hibernated = await runtime.hibernateIfIdle(Date.now() + 20);

    expect(hibernated).toMatchObject({
      state: "hibernated",
      tabs: [expect.objectContaining({ url: "https://example.com/" })],
    });
    await expect(runtime.open({ profile: "default", deviceId: "device_1" })).resolves.toMatchObject({
      state: "active",
      tabs: [expect.objectContaining({ url: "https://example.com/" })],
    });
  });

  it("scopes recoverable tab state to the hibernated profile", async () => {
    const runtime = new BrowserRuntimeService({
      launcher: async () => fakeBrowser(),
      profileRoot: "/tmp/browser-profiles",
      limits: { idleMs: 10 },
      resolveHostname: async () => ["93.184.216.34"],
    });

    await runtime.open({ profile: "work", deviceId: "device_1" });
    runtime.createTab({ url: "https://work.example/" });
    await runtime.hibernateIfIdle(Date.now() + 20);

    await expect(runtime.open({ profile: "personal", deviceId: "device_1" })).resolves.toMatchObject({
      profile: "personal",
      tabs: [],
    });
    await expect(runtime.open({ profile: "work", deviceId: "device_1" })).resolves.toMatchObject({
      profile: "work",
      tabs: [expect.objectContaining({ url: "https://work.example/" })],
    });
  });
});
