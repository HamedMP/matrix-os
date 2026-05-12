import { describe, expect, it } from "vitest";
import { generateKeyPair } from "node:crypto";
import { promisify } from "node:util";
import { InMemoryBrowserRepository } from "../../packages/gateway/src/browser/repository.js";
import { createBrowserRoutes } from "../../packages/gateway/src/browser/routes.js";
import { BrowserService } from "../../packages/gateway/src/browser/service.js";
import { BrowserStreamHub, browserTakenOverMessage } from "../../packages/gateway/src/browser/ws.js";
import { signBrowserHandoffToken } from "../../packages/gateway/src/handoff-token.js";

const generateRsa = promisify(generateKeyPair);

describe("Browser gateway routes", () => {
  it("returns coarse Browser capability data only", async () => {
    const app = createBrowserRoutes();
    const res = await app.request("/capability");
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      available: true,
      capacityState: "ok",
      activeSessionCount: 0,
      limits: { maxSessions: 1, maxTabs: 12, maxStreams: 3 },
    });
  });

  it("validates session payloads at the route boundary with safe errors", async () => {
    const app = createBrowserRoutes();
    const res = await app.request("/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profileName: "../bad", surface: "canvas", deviceId: "" }),
    });
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body).toEqual({ error: { code: "validation_error", message: "Browser request is invalid." } });
  });

  it("binds created sessions to the authenticated owner scope", async () => {
    const service = new BrowserService({
      repo: new InMemoryBrowserRepository(),
      streamTokenSecret: "test-stream-secret",
    });
    const app = createBrowserRoutes({ getOwnerId: () => "owner_1", service });
    const res = await app.request("/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profileName: "default", surface: "canvas", deviceId: "device_1" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { session: { id: string; ownerId: string; profileId: string }; streamToken: string };
    expect(body).toMatchObject({
      session: {
        ownerId: "owner_1",
        id: expect.stringMatching(/^browser_session_/),
        profileId: expect.stringMatching(/^browser_profile_/),
      },
    });
    expect(service.verifyStreamToken({
      token: body.streamToken,
      sessionId: body.session.id,
    })).toMatchObject({
      ownerId: "owner_1",
      sessionId: body.session.id,
    });
    expect(() => service.verifyStreamToken({
      token: body.streamToken,
      sessionId: "other_session",
    })).toThrow("invalid_browser_stream_token");
  });

  it("applies body limits before mutating session routes", async () => {
    const app = createBrowserRoutes();
    const body = JSON.stringify({ profileName: "x".repeat(20_000), surface: "canvas", deviceId: "device" });
    const res = await app.request("/sessions", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) },
      body,
    });
    expect(res.status).toBe(413);
  });

  it("persists sessions through an owner-scoped repository", async () => {
    const repo = new InMemoryBrowserRepository();
    const service = new BrowserService({ repo });
    const first = await service.createSession({
      ownerId: "owner_1",
      profileName: "default",
      deviceId: "device_1",
      surface: "canvas",
      targetUrl: "https://example.com/",
    });
    const resumed = await service.createSession({
      ownerId: "owner_1",
      profileName: "default",
      deviceId: "device_1",
      surface: "canvas",
      targetUrl: "https://example.com/next",
    });

    expect(resumed.session.id).toBe(first.session.id);
    expect(await repo.listSessions("owner_1")).toHaveLength(1);
    expect(await repo.listSessions("owner_2")).toHaveLength(0);
  });

  it("requires takeover for another device on the same owner profile", async () => {
    const service = new BrowserService({ repo: new InMemoryBrowserRepository() });
    await service.createSession({
      ownerId: "owner_1",
      profileName: "default",
      deviceId: "device_1",
      surface: "canvas",
    });

    const second = await service.createSession({
      ownerId: "owner_1",
      profileName: "default",
      deviceId: "device_2",
      surface: "standalone",
    });

    expect(second.session.takeoverRequired).toBe(true);
    expect(second.session.lockDeviceId).toBe("device_1");
    expect(second.streamToken).toBeNull();
    expect(second.wsUrl).toBeNull();
  });

  it("takes over a locked session, marks the old session recoverable, and audits", async () => {
    const repo = new InMemoryBrowserRepository();
    const service = new BrowserService({ repo, streamTokenSecret: "test-stream-secret" });
    const delivered: string[] = [];
    const closed: string[] = [];
    const streamHub = new BrowserStreamHub();
    const app = createBrowserRoutes({
      getOwnerId: () => "owner_1",
      service,
      streamHub,
    });
    const first = await service.createSession({
      ownerId: "owner_1",
      profileName: "default",
      deviceId: "device_1",
      surface: "canvas",
      now: 1_000,
    });
    streamHub.register({
      id: "old_stream",
      ownerId: "owner_1",
      sessionId: first.session.id,
      sender: {
        send(message) {
          delivered.push(message);
        },
        close() {
          closed.push("old_stream");
        },
      },
    });

    const takeover = await app.request(`/sessions/${first.session.id}/takeover`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceId: "device_2", confirm: true }),
    });

    expect(takeover.status).toBe(200);
    const body = await takeover.json() as { session: { id: string; lockDeviceId: string }; streamToken: string };
    expect(body.session.id).not.toBe(first.session.id);
    expect(body.session.lockDeviceId).toBe("device_2");
    expect(service.verifyStreamToken({ token: body.streamToken, sessionId: body.session.id })).toMatchObject({
      ownerId: "owner_1",
      sessionId: body.session.id,
    });
    expect(streamHub.size()).toBe(0);
    expect(closed).toEqual(["old_stream"]);
    expect(JSON.parse(delivered[0] ?? "{}")).toEqual(browserTakenOverMessage());
    expect(await repo.getSession("owner_1", first.session.id)).toMatchObject({ state: "recoverable" });
    expect((await repo.listAuditEvents("owner_1")).map((event) => event.eventType)).toEqual([
      "session.created",
      "session.closed",
      "session.taken_over",
      "session.created",
    ]);
  });

  it("clears explicit profile scopes and audits without leaking sensitive metadata", async () => {
    const repo = new InMemoryBrowserRepository();
    const service = new BrowserService({ repo });
    await service.createSession({
      ownerId: "owner_1",
      profileName: "default",
      deviceId: "device_1",
      surface: "canvas",
    });

    const profile = await service.clearProfile({
      ownerId: "owner_1",
      profileName: "default",
      scopes: ["cookies", "savedPasswords", "downloads"],
    });

    expect(profile.clearedScopes).toEqual(["cookies", "savedPasswords", "downloads"]);
    expect(await repo.listAuditEvents("owner_1")).toEqual([
      expect.objectContaining({
        eventType: "session.created",
      }),
      expect.objectContaining({
        eventType: "session.closed",
      }),
      expect.objectContaining({
        eventType: "profile.cleared",
        metadata: { profileName: "default", scopes: ["cookies", "savedPasswords", "downloads"] },
      }),
    ]);
    expect((await repo.listSessions("owner_1"))[0]?.state).toBe("closed");
  });

  it("accepts every profile clear scope including browser stores and saved passwords", async () => {
    const service = new BrowserService({ repo: new InMemoryBrowserRepository() });
    const scopes = [
      "cookies",
      "localStorage",
      "sessionStorage",
      "indexedDb",
      "cache",
      "serviceWorkers",
      "sitePermissions",
      "savedFormData",
      "savedPasswords",
      "history",
      "downloads",
    ] as const;

    const profile = await service.clearProfile({
      ownerId: "owner_1",
      profileName: "default",
      scopes: [...scopes],
    });

    expect(profile.clearedScopes).toEqual(scopes);
  });

  it("creates, lists, expires, and revokes browser permission grants", async () => {
    const repo = new InMemoryBrowserRepository();
    const service = new BrowserService({ repo });
    const now = 1_000;
    const grant = await service.createGrant({
      ownerId: "owner_1",
      sessionId: "session_1",
      scopes: ["read_dom", "automate_input"],
      domains: ["example.com"],
      now,
    });

    expect(grant.expiresAt).toBe(new Date(now + 8 * 60 * 60 * 1000).toISOString());
    expect(await service.listActiveGrants({ ownerId: "owner_1", now: now + 1_000 })).toHaveLength(1);
    expect(await service.listActiveGrants({ ownerId: "owner_2", now: now + 1_000 })).toHaveLength(0);
    await service.revokeGrant({ ownerId: "owner_1", grantId: grant.id, now: now + 2_000 });
    expect(await service.listActiveGrants({ ownerId: "owner_1", now: now + 3_000 })).toEqual([]);
  });

  it("rejects grant domains that are not hostnames", async () => {
    const service = new BrowserService({ repo: new InMemoryBrowserRepository() });
    await expect(service.createGrant({
      ownerId: "owner_1",
      sessionId: "session_1",
      scopes: ["read_dom"],
      domains: ["https://example.com/secret"],
      now: 1_000,
    })).rejects.toThrow("invalid_grant_domain");
  });

  it("enforces agent action grants by scope and domain", async () => {
    const service = new BrowserService({ repo: new InMemoryBrowserRepository() });
    await service.createGrant({
      ownerId: "owner_1",
      sessionId: "session_1",
      scopes: ["navigate"],
      domains: ["example.com"],
      now: 1_000,
    });

    await expect(service.authorizeAgentAction({
      ownerId: "owner_1",
      sessionId: "session_1",
      action: "navigate",
      url: "https://example.com/page",
      now: 2_000,
    })).resolves.toBeDefined();
    await expect(service.authorizeAgentAction({
      ownerId: "owner_1",
      sessionId: "session_1",
      action: "read_dom",
      url: "https://example.com/page",
      now: 2_000,
    })).rejects.toThrow("Browser permission is required");
    await expect(service.authorizeAgentAction({
      ownerId: "owner_1",
      sessionId: "session_1",
      action: "navigate",
      url: "https://evil.example.net/",
      now: 2_000,
    })).rejects.toThrow("Browser permission is required");
  });

  it("enforces every agent browser grant scope and emits redacted access audit", async () => {
    const repo = new InMemoryBrowserRepository();
    const service = new BrowserService({ repo });
    const scopes = ["read_dom", "screenshot", "navigate", "download", "automate_input"] as const;
    await service.createGrant({
      ownerId: "owner_1",
      sessionId: "session_1",
      scopes: [...scopes],
      domains: ["*.example.com"],
      now: 1_000,
    });

    for (const action of scopes) {
      await expect(service.authorizeAgentAction({
        ownerId: "owner_1",
        sessionId: "session_1",
        action,
        url: "https://docs.example.com/page?token=secret",
        now: 2_000,
      })).resolves.toBeDefined();
    }

    await expect(service.authorizeAgentAction({
      ownerId: "owner_1",
      sessionId: "session_1",
      action: "screenshot",
      url: "https://example.net/",
      now: 2_000,
    })).rejects.toThrow("Browser permission is required");
    expect((await repo.listAuditEvents("owner_1")).filter((event) => event.eventType === "agent.access")).toEqual([
      expect.objectContaining({ metadata: { sessionId: "session_1", action: "read_dom", host: "docs.example.com" } }),
      expect.objectContaining({ metadata: { sessionId: "session_1", action: "screenshot", host: "docs.example.com" } }),
      expect.objectContaining({ metadata: { sessionId: "session_1", action: "navigate", host: "docs.example.com" } }),
      expect.objectContaining({ metadata: { sessionId: "session_1", action: "download", host: "docs.example.com" } }),
      expect.objectContaining({ metadata: { sessionId: "session_1", action: "automate_input", host: "docs.example.com" } }),
    ]);
  });

  it("exposes profile clear and grant routes with owner isolation", async () => {
    const repo = new InMemoryBrowserRepository();
    const app = createBrowserRoutes({
      getOwnerId: () => "owner_1",
      service: new BrowserService({ repo }),
    });

    const clear = await app.request("/profiles/default/clear", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scopes: ["cookies", "savedPasswords"] }),
    });
    expect(clear.status).toBe(200);
    await expect(clear.json()).resolves.toEqual({
      profile: expect.objectContaining({
        ownerId: "owner_1",
        name: "default",
        clearedScopes: ["cookies", "savedPasswords"],
      }),
    });

    const grantRes = await app.request("/grants", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: "session_1",
        scopes: ["read_dom"],
        domains: ["example.com"],
      }),
    });
    expect(grantRes.status).toBe(200);
    const grantBody = await grantRes.json() as { grant: { id: string } };

    const list = await app.request("/grants");
    await expect(list.json()).resolves.toEqual({
      grants: [expect.objectContaining({ ownerId: "owner_1", domains: ["example.com"] })],
    });

    const revoke = await app.request(`/grants/${grantBody.grant.id}`, { method: "DELETE" });
    expect(revoke.status).toBe(200);
    await expect((await app.request("/grants")).json()).resolves.toEqual({ grants: [] });
  });

  it("stores tabs, downloads, and audit pages with owner filters", async () => {
    const repo = new InMemoryBrowserRepository();
    const service = new BrowserService({ repo });
    const app = createBrowserRoutes({
      getOwnerId: () => "owner_1",
      service,
    });
    const session = await service.createSession({
      ownerId: "owner_1",
      profileName: "default",
      deviceId: "device_1",
      surface: "canvas",
      now: 1_000,
    });
    await service.createSession({
      ownerId: "owner_2",
      profileName: "default",
      deviceId: "device_2",
      surface: "canvas",
      now: 1_000,
    });

    const tabCreate = await app.request(`/sessions/${session.session.id}/tabs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ targetUrl: "https://example.com/" }),
    });
    expect(tabCreate.status).toBe(200);
    await expect((await app.request(`/sessions/${session.session.id}/tabs`)).json()).resolves.toEqual({
      tabs: [expect.objectContaining({
        ownerId: "owner_1",
        sessionId: session.session.id,
        url: "https://example.com/",
      })],
    });

    const download = await service.createDownload({
      ownerId: "owner_1",
      sessionId: session.session.id,
      filename: "report.pdf",
      stagedPath: "/safe/staged/report.pdf",
      now: 2_000,
    });
    await service.completeDownload({
      ownerId: "owner_1",
      downloadId: download.id,
      completedPath: "/safe/downloads/report.pdf",
      now: 3_000,
    });
    await service.createDownload({
      ownerId: "owner_2",
      sessionId: "session_other",
      filename: "other.pdf",
      now: 2_000,
    });

    await expect((await app.request("/downloads")).json()).resolves.toEqual({
      downloads: [expect.objectContaining({
        id: download.id,
        ownerId: "owner_1",
        state: "complete",
        filename: "report.pdf",
      })],
      nextCursor: null,
    });

    await expect((await app.request("/downloads?limit=1&cursor=0")).json()).resolves.toEqual({
      downloads: [expect.objectContaining({ id: download.id })],
      nextCursor: null,
    });

    const audit = await app.request("/audit?limit=2");
    const auditBody = await audit.json() as { events: Array<{ eventType: string; ownerId: string }>; nextCursor: string | null };
    expect(auditBody.events).toHaveLength(2);
    expect(auditBody.events.every((event) => event.ownerId === "owner_1")).toBe(true);
    expect(auditBody.events.map((event) => event.eventType)).toContain("download.completed");
    expect(auditBody.nextCursor).toEqual(expect.any(String));
  });

  it("closes sessions and deletes downloads through bounded mutating routes", async () => {
    const repo = new InMemoryBrowserRepository();
    const service = new BrowserService({ repo });
    const app = createBrowserRoutes({
      getOwnerId: () => "owner_1",
      service,
    });
    const session = await service.createSession({
      ownerId: "owner_1",
      profileName: "default",
      deviceId: "device_1",
      surface: "canvas",
      now: 1_000,
    });
    const download = await service.createDownload({
      ownerId: "owner_1",
      sessionId: session.session.id,
      filename: "report.pdf",
      now: 2_000,
    });

    const close = await app.request(`/sessions/${session.session.id}/close`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "idle" }),
    });
    expect(close.status).toBe(200);
    await expect(close.json()).resolves.toEqual({
      session: expect.objectContaining({ state: "hibernated" }),
    });

    const deleted = await app.request(`/downloads/${download.id}`, { method: "DELETE" });
    expect(deleted.status).toBe(200);
    await expect((await app.request("/downloads")).json()).resolves.toEqual({ downloads: [], nextCursor: null });
    expect((await repo.listAuditEvents("owner_1")).map((event) => event.eventType)).toContain("download.deleted");
  });

  it("verifies owner VPS handoff tokens before bootstrapping sessions", async () => {
    const { privateKey, publicKey } = await generateRsa("rsa", { modulusLength: 2048 });
    const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
    const token = await signBrowserHandoffToken({
      privateKey,
      keyId: "browser-key-1",
      ownerId: "owner_1",
      deviceId: "device_1",
      target: "https://example.com/from-handoff",
      nonce: "nonce_route",
      now: Date.now(),
    });
    const repo = new InMemoryBrowserRepository();
    const app = createBrowserRoutes({
      getOwnerId: () => "owner_1",
      handoffPublicKey: publicKeyPem,
      service: new BrowserService({ repo }),
    });

    const res = await app.request("/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        profileName: "default",
        targetUrl: "https://ignored.example/",
        handoffToken: token,
        surface: "standalone",
        deviceId: "device_1",
      }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      session: { ownerId: "owner_1" },
    });
    expect(await repo.listAuditEvents("owner_1")).toEqual([
      expect.objectContaining({ eventType: "session.created" }),
      expect.objectContaining({
        eventType: "navigation.attempted",
        metadata: expect.objectContaining({ url: "https://example.com/from-handoff" }),
      }),
    ]);
  });
});
