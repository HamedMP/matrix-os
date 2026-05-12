import { describe, expect, it } from "vitest";
import { InMemoryBrowserRepository } from "../../packages/gateway/src/browser/repository.js";
import { createTakeoverAuditEvent, recordTakeover } from "../../packages/gateway/src/browser/service.js";
import { browserTakenOverMessage } from "../../packages/gateway/src/browser/ws.js";
import { SessionManager } from "../../packages/mcp-browser/src/session-manager.js";
import type { BrowserLike, PageLike } from "../../packages/mcp-browser/src/session-manager.js";

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

describe("Browser focus lease and takeover audit", () => {
  it("records explicit session takeover audit events", () => {
    expect(createTakeoverAuditEvent({
      ownerId: "owner_1",
      sessionId: "session_1",
      deviceId: "device_1",
      now: 1_000,
    })).toMatchObject({
      ownerId: "owner_1",
      eventType: "session.taken_over",
      createdAt: new Date(1_000).toISOString(),
      metadata: { sessionId: "session_1", deviceId: "device_1" },
    });
  });

  it("releases focus surfaces on second-device takeover and exposes the stream takeover message", async () => {
    const manager = new SessionManager({ launcher: async () => fakeBrowser() });
    const session = await manager.launch({ profile: "default", deviceId: "device_1" });
    manager.attachSurface({ sessionId: session.id, surfaceId: "canvas", deviceId: "device_1", kind: "canvas" });
    manager.focusSurface("canvas");

    manager.takeover({ deviceId: "device_2" });

    expect(manager.getActive()?.lockDeviceId).toBe("device_2");
    expect(manager.getActive()?.focusSurfaceId).toBeUndefined();
    expect(manager.getActive()?.surfaces?.size).toBe(0);
    expect(browserTakenOverMessage()).toEqual({
      type: "stream.taken_over",
      payload: { message: "Browser was opened on another device." },
    });
  });

  it("keeps audit retention bounded to 180 days by default", async () => {
    const repo = new InMemoryBrowserRepository();
    await recordTakeover(repo, { ownerId: "owner_1", sessionId: "old", deviceId: "device_1", now: 1_000 });
    await recordTakeover(repo, { ownerId: "owner_1", sessionId: "fresh", deviceId: "device_1", now: 200 * 24 * 60 * 60 * 1000 });

    expect(repo.pruneAuditEvents({ ownerId: "owner_1", now: 200 * 24 * 60 * 60 * 1000 })).toBe(1);
    expect(repo.listAuditEvents("owner_1")).toHaveLength(1);
  });

  it("redacts sensitive audit metadata", () => {
    const repo = new InMemoryBrowserRepository();
    repo.addAuditEvent({
      id: "audit_1",
      ownerId: "owner_1",
      eventType: "agent.access",
      createdAt: new Date(1_000).toISOString(),
      metadata: {
        url: "https://example.com/",
        cookie: "secret",
        screenshotPath: "/home/owner/file.png",
        html: "<form>secret</form>",
      },
    });

    expect(repo.listAuditEvents("owner_1")[0]?.metadata).toEqual({ url: "https://example.com/" });
  });

  it("serializes agent automate_input without taking the UI focus lease", async () => {
    const manager = new SessionManager({ launcher: async () => fakeBrowser() });
    await manager.launch({ profile: "default", deviceId: "device_1" });
    manager.attachSurface({ sessionId: manager.getActive()!.id, surfaceId: "canvas", deviceId: "device_1", kind: "canvas" });
    manager.focusSurface("canvas");

    const result = await manager.enqueueAction(async () => "automated", { agent: true });

    expect(result).toBe("automated");
    expect(manager.getActive()?.focusSurfaceId).toBe("canvas");
  });
});
