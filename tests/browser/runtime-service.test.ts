import { describe, expect, it } from "vitest";
import { BrowserRuntimeService } from "../../packages/mcp-browser/src/runtime-service.js";
import type { BrowserLike, PageLike } from "../../packages/mcp-browser/src/session-manager.js";

function fakePage(): PageLike {
  let currentUrl = "about:blank";
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

describe("BrowserRuntimeService", () => {
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

    runtime.assertOwnerLimits({ sessions: 0, streams: 2, memoryBytes: 1024, profileBytes: 2048 });
    expect(() => runtime.assertOwnerLimits({ sessions: 1 })).toThrow("browser_session_limit_reached");
    expect(() => runtime.assertOwnerLimits({ streams: 3 })).toThrow("browser_stream_limit_reached");
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
});
