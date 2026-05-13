import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryBrowserRepository } from "../../packages/gateway/src/browser/repository.js";
import { BrowserService } from "../../packages/gateway/src/browser/service.js";

describe("BrowserService", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("withholds stream credentials until second-device takeover is confirmed", async () => {
    const repo = new InMemoryBrowserRepository();
    const service = new BrowserService({ repo, streamTokenSecret: "secret".repeat(8) });

    const first = await service.createSession({
      ownerId: "owner_1",
      profileName: "default",
      deviceId: "device_a",
      surface: "canvas",
      now: 1_000,
    });
    const locked = await service.createSession({
      ownerId: "owner_1",
      profileName: "default",
      deviceId: "device_b",
      surface: "standalone",
      now: 2_000,
    });

    expect(first.streamToken).toEqual(expect.any(String));
    expect(locked.session).toMatchObject({ id: first.session.id, takeoverRequired: true });
    expect(locked.streamToken).toBeNull();
    expect(locked.wsUrl).toBeNull();
  });

  it("rejects replayed stream tokens", async () => {
    const repo = new InMemoryBrowserRepository();
    const service = new BrowserService({ repo, streamTokenSecret: "secret".repeat(8) });
    const session = await service.createSession({
      ownerId: "owner_1",
      profileName: "default",
      deviceId: "device_a",
      surface: "canvas",
      now: 1_000,
    });

    expect(service.verifyStreamToken({
      token: session.streamToken,
      sessionId: session.session.id,
      now: 2_000,
    })).toMatchObject({ ownerId: "owner_1" });
    expect(() => service.verifyStreamToken({
      token: session.streamToken,
      sessionId: session.session.id,
      now: 2_001,
    })).toThrow("Browser stream token is invalid.");
  });

  it("rejects stale session ids during takeover", async () => {
    const repo = new InMemoryBrowserRepository();
    const service = new BrowserService({ repo, streamTokenSecret: "secret".repeat(8) });
    const session = await service.createSession({
      ownerId: "owner_1",
      profileName: "default",
      deviceId: "device_a",
      surface: "canvas",
      now: 1_000,
    });
    await service.closeSession({ ownerId: "owner_1", sessionId: session.session.id, state: "recoverable" });

    await expect(service.takeoverSession({
      ownerId: "owner_1",
      sessionId: session.session.id,
      deviceId: "device_b",
    })).rejects.toMatchObject({ code: "session_not_found" });
  });

  it("clears profiles and closes active sessions in one repository operation", async () => {
    const repo = new InMemoryBrowserRepository();
    const service = new BrowserService({ repo, streamTokenSecret: "secret".repeat(8) });
    const session = await service.createSession({
      ownerId: "owner_1",
      profileName: "default",
      deviceId: "device_a",
      surface: "canvas",
      now: 1_000,
    });

    await service.clearProfile({
      ownerId: "owner_1",
      profileName: "default",
      scopes: ["cookies", "savedPasswords"],
      now: 2_000,
    });

    await expect(service.listSessions({ ownerId: "owner_1" })).resolves.toContainEqual(
      expect.objectContaining({ id: session.session.id, state: "closed" }),
    );
  });

  it("rejects malformed agent action URLs with safe errors", async () => {
    const service = new BrowserService({
      repo: new InMemoryBrowserRepository(),
      streamTokenSecret: "secret".repeat(8),
    });

    await expect(service.authorizeAgentAction({
      ownerId: "owner_1",
      sessionId: "session_1",
      action: "navigate",
      url: "not-a-url",
    })).rejects.toMatchObject({ code: "invalid_url", message: "Browser URL is invalid." });
  });

  it("rejects stale tab ids from another owner or session", async () => {
    const repo = new InMemoryBrowserRepository();
    const service = new BrowserService({ repo, streamTokenSecret: "secret".repeat(8) });
    const first = await service.createSession({
      ownerId: "owner_1",
      profileName: "default",
      deviceId: "device_a",
      surface: "canvas",
      now: 1_000,
    });
    const second = await service.createSession({
      ownerId: "owner_2",
      profileName: "default",
      deviceId: "device_b",
      surface: "canvas",
      now: 1_000,
    });
    const tab = await service.upsertTab({
      ownerId: "owner_1",
      sessionId: first.session.id,
      url: "https://example.com/",
    });

    await expect(service.upsertTab({
      ownerId: "owner_2",
      sessionId: second.session.id,
      tabId: tab.id,
      url: "https://example.org/",
    })).rejects.toThrow("tab_session_mismatch");
  });

  it("uses the gateway session id for runtime launch and follow-up navigation", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }));
    const repo = new InMemoryBrowserRepository();
    const service = new BrowserService({
      repo,
      streamTokenSecret: "secret".repeat(8),
      runtimeBaseUrl: "http://127.0.0.1:4011",
    });
    const session = await service.createSession({
      ownerId: "owner_1",
      profileName: "default",
      deviceId: "device_a",
      surface: "standalone",
      targetUrl: "https://example.com/",
      now: 1_000,
    });

    await service.navigateSession({
      ownerId: "owner_1",
      sessionId: session.session.id,
      targetUrl: "https://example.com/docs",
      surface: "standalone",
      now: 2_000,
    });

    expect(calls).toEqual([
      {
        url: "http://127.0.0.1:4011/sessions",
        body: expect.objectContaining({ sessionId: session.session.id, targetUrl: "https://example.com/" }),
      },
      {
        url: `http://127.0.0.1:4011/sessions/${session.session.id}/navigate`,
        body: { targetUrl: "https://example.com/docs" },
      },
    ]);
    expect(repo.listTabs("owner_1", session.session.id)).toContainEqual(
      expect.objectContaining({ url: "https://example.com/docs" }),
    );
  });

  it("does not resurrect deleted downloads on late completion", async () => {
    const repo = new InMemoryBrowserRepository();
    const service = new BrowserService({ repo, streamTokenSecret: "secret".repeat(8) });
    const session = await service.createSession({
      ownerId: "owner_1",
      profileName: "default",
      deviceId: "device_a",
      surface: "canvas",
    });
    const download = await service.createDownload({
      ownerId: "owner_1",
      sessionId: session.session.id,
      filename: "report.pdf",
    });

    await service.deleteDownload({ ownerId: "owner_1", downloadId: download.id });

    await expect(service.completeDownload({
      ownerId: "owner_1",
      downloadId: download.id,
      completedPath: "/home/matrix/home/files/downloads/report.pdf",
    })).resolves.toBeNull();
    await expect(service.listDownloads({ ownerId: "owner_1" })).resolves.toEqual([]);
    expect((await repo.listAuditEvents("owner_1")).map((event) => event.eventType)).toContain("download.deleted");
  });

  it("paginates audit events with a stable tie-breaker", async () => {
    const repo = new InMemoryBrowserRepository();
    const createdAt = new Date(1_000).toISOString();
    for (const id of ["audit_1", "audit_2", "audit_3"]) {
      repo.addAuditEvent({ id, ownerId: "owner_1", eventType: "session.created", createdAt });
    }

    const first = repo.listAuditPage({ ownerId: "owner_1", limit: 2 });
    const second = repo.listAuditPage({ ownerId: "owner_1", limit: 2, cursor: first.nextCursor ?? undefined });

    expect(first.events.map((event) => event.id)).toEqual(["audit_3", "audit_2"]);
    expect(second.events.map((event) => event.id)).toEqual(["audit_1"]);
  });
});
