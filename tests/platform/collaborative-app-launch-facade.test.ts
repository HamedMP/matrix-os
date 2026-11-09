import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CollaborativeAppLaunchSessions,
  type CollaborativeAppLaunchUpstream,
} from "../../packages/platform/src/collaboration/app-launch-sessions.js";
import { createCollaborativeAppLaunchUpstreamFactory } from "../../packages/platform/src/collaboration/app-launch-upstream.js";
import { bootstrapPlatformCollaborationDatabase } from "../../packages/platform/src/collaboration/database.js";
import { PlatformCollaborationRepository } from "../../packages/platform/src/collaboration/repository.js";
import { createPlatformCollaborationRoutes } from "../../packages/platform/src/collaboration/routes.js";
import { proofKeyThumbprint } from "../../packages/platform/src/collaboration/ticket-crypto.js";
import {
  createPlatformCollaborationTestDatabase,
  destroyPlatformCollaborationTestDatabase,
  platformCollaborationActors,
  type PlatformCollaborationTestDatabase,
} from "./collaboration-test-support.js";

const nowDate = new Date("2026-11-05T10:00:00.000Z");
const scopeId = "10000000-0000-4000-8000-000000000001";
const launchId = "30000000-0000-4000-8000-000000000001";
const requestId = "40000000-0000-4000-8000-000000000001";
const actorId = platformCollaborationActors.recipientWithoutComputer;
const organizationId = "org_matrix_team";
const app = {
  appId: "team-tracker",
  catalogId: "50000000-0000-4000-8000-000000000001",
  readinessId: "60000000-0000-4000-8000-000000000001",
  registrationIncarnation: "a".repeat(64),
  buildId: "b".repeat(64),
  shareRevision: 1,
  state: "active" as const,
};

describe("collaborative app authenticated launch facade", () => {
  let fixture: PlatformCollaborationTestDatabase;
  let repository: PlatformCollaborationRepository;
  let routes: Hono;
  let sessions: CollaborativeAppLaunchSessions;
  let currentTime: number;
  let currentOrganizations: string[];
  let upstream: CollaborativeAppLaunchUpstream;
  const request = vi.fn();
  const close = vi.fn();

  beforeEach(async () => {
    fixture = await createPlatformCollaborationTestDatabase();
    await bootstrapPlatformCollaborationDatabase(fixture.collaborationDb);
    repository = new PlatformCollaborationRepository(fixture.collaborationDb, { now: () => nowDate });
    currentTime = nowDate.getTime();
    currentOrganizations = [organizationId];
    request.mockReset();
    close.mockReset();
    request.mockImplementation(async (assetPath: string) => new Response(
      assetPath === "index.html" ? "<main>shared</main>" : "console.log('shared')",
      { headers: { "content-type": assetPath.endsWith(".html") ? "text/html; charset=utf-8" : "text/javascript; charset=utf-8" } },
    ));
    close.mockResolvedValue(undefined);
    upstream = { request, close };
    sessions = new CollaborativeAppLaunchSessions({
      open: async () => upstream,
      now: () => currentTime,
      createId: () => launchId,
      startTimer: false,
      maxSessions: 2,
      maxPerActor: 2,
      ttlMs: 60_000,
      maxResponseBytes: 32,
    });
    routes = new Hono();
    routes.route("/", createPlatformCollaborationRoutes({
      repository,
      launchSessions: sessions,
      resolveActor: async (context) => context.req.header("x-test-actor") ?? null,
      authenticateRuntime: async ({ runtimeId }) => runtimeId === "runtime_owner"
        ? { runtimeId, ownerId: platformCollaborationActors.owner }
        : null,
      resolveParticipant: async (id) => ({ actorId: id, displayName: id === platformCollaborationActors.owner ? "Owner" : "Member" }),
      resolveInvitationIdentifier: async () => null,
      listOrganizationIds: async () => currentOrganizations,
      now: () => nowDate,
    }));
    await repository.applyDirectoryEvent({
      eventId: "20000000-0000-4000-8000-000000000001",
      scopeId,
      runtimeId: "runtime_owner",
      ownerId: platformCollaborationActors.owner,
      kind: "app",
      organizationId,
      audience: "current_membership",
      authorityGeneration: 1,
      metadataRevision: 1,
      app,
      recipients: [{ actorId: platformCollaborationActors.owner, status: "accepted" }],
    });
  });

  afterEach(async () => {
    await sessions.close();
    await destroyPlatformCollaborationTestDatabase(fixture);
    vi.restoreAllMocks();
  });

  it("creates an idempotent path-bound launch and serves safe immutable bytes without a browser credential", async () => {
    const create = () => routes.request(`/api/collaboration/shared-apps/${scopeId}/launch`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-actor": actorId },
      body: JSON.stringify({ clientRequestId: requestId, expectedShareRevision: "1", expectedBuildId: app.buildId }),
    });
    const first = await create();
    expect(first.status).toBe(201);
    const launch = await first.json() as { launchId: string; entryUrl: string; expiresAt: string; target: unknown };
    expect(launch).toMatchObject({
      launchId,
      entryUrl: `/api/collaboration/shared-apps/${scopeId}/runtime/${launchId}/index.html`,
      target: { kind: "shared", scopeId, appId: app.appId, buildId: app.buildId },
    });
    expect(JSON.stringify(launch)).not.toMatch(/credential|session|proof|token/i);
    expect((await create()).status).toBe(201);
    expect(sessions.size).toBe(1);

    const asset = await routes.request(launch.entryUrl, { headers: { "x-test-actor": actorId } });
    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(asset.headers.get("x-content-type-options")).toBe("nosniff");
    expect(asset.headers.get("cache-control")).toBe("private, no-store");
    expect(asset.headers.get("content-security-policy")).toContain("sandbox allow-scripts");
    const html = await asset.text();
    expect(html).toContain(`<base href="/api/collaboration/shared-apps/${scopeId}/runtime/${launchId}/">`);
    expect(html).toContain(`"actorId":"${actorId}"`);
    expect(html).toContain('"organizationId":"org_matrix_team"');
    expect(html).not.toMatch(/credential|proof|token|ownerCookie/i);
    expect(request).toHaveBeenCalledWith("index.html", expect.any(AbortSignal));
  });

  it("keeps the owner relay alive for the full asset-download deadline", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(new AbortController().signal);
    await sessions.create({ actorId, clientRequestId: requestId, scopeId, organizationId, runtimeId: "runtime_owner",
      authorityGeneration: 1, appId: app.appId, catalogId: app.catalogId, buildId: app.buildId, shareRevision: 1 });

    await sessions.request({ launchId, actorId, scopeId, assetPath: "assets/main.js" });

    expect(timeout).toHaveBeenCalledWith(30_000);
  });

  it("rechecks the platform session, current membership, share, build, and confined path on every request", async () => {
    await sessions.create({ actorId, clientRequestId: requestId, scopeId, organizationId, runtimeId: "runtime_owner",
      authorityGeneration: 1, appId: app.appId, catalogId: app.catalogId, buildId: app.buildId, shareRevision: 1 });
    const url = `/api/collaboration/shared-apps/${scopeId}/runtime/${launchId}/index.html`;
    expect((await routes.request(url)).status).toBe(401);
    currentOrganizations = [];
    expect((await routes.request(url, { headers: { "x-test-actor": actorId } })).status).toBe(404);
    expect(sessions.size).toBe(0);
    expect(close).toHaveBeenCalledTimes(1);
    currentOrganizations = [organizationId];
    expect((await routes.request(`/api/collaboration/shared-apps/${scopeId}/runtime/${launchId}/%2e%2e%2fsecret`, {
      headers: { "x-test-actor": actorId },
    })).status).toBe(422);
    await repository.applyDirectoryEvent({
      eventId: "20000000-0000-4000-8000-000000000002", scopeId, runtimeId: "runtime_owner",
      ownerId: platformCollaborationActors.owner, kind: "app", organizationId, audience: "current_membership",
      authorityGeneration: 1, metadataRevision: 2, app: { ...app, state: "needs_recheck" },
      recipients: [{ actorId: platformCollaborationActors.owner, status: "accepted" }],
    });
    expect((await routes.request(url, { headers: { "x-test-actor": actorId } })).status).toBe(404);
    expect(request).not.toHaveBeenCalled();
  });

  it("bounds TTL/LRU, response size and type, rejects redirects, and propagates stream cancellation", async () => {
    const identity = { actorId, scopeId, organizationId, runtimeId: "runtime_owner", authorityGeneration: 1,
      appId: app.appId, catalogId: app.catalogId, buildId: app.buildId, shareRevision: 1 };
    await sessions.create({ ...identity, clientRequestId: requestId });
    currentTime += 60_001;
    expect(await sessions.sweep()).toBe(1);
    expect(close).toHaveBeenCalledTimes(1);

    request.mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "https://owner.invalid/secret" } }));
    await sessions.create({ ...identity, clientRequestId: "40000000-0000-4000-8000-000000000002" });
    await expect(sessions.request({ launchId, actorId, scopeId, assetPath: "index.html" }))
      .rejects.toMatchObject({ code: "unavailable" });
    request.mockResolvedValueOnce(new Response("secret", { headers: { "content-type": "text/x-private" } }));
    await expect(sessions.request({ launchId, actorId, scopeId, assetPath: "index.html" }))
      .rejects.toMatchObject({ code: "unavailable" });
    request.mockResolvedValueOnce(new Response("x".repeat(33), { headers: { "content-type": "text/javascript; charset=utf-8", "content-length": "33" } }));
    await expect(sessions.request({ launchId, actorId, scopeId, assetPath: "main.js" }))
      .rejects.toMatchObject({ code: "unavailable" });

    const cancelled = vi.fn();
    request.mockResolvedValueOnce(new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode("ok")); },
      cancel: cancelled,
    }), { headers: { "content-type": "text/javascript; charset=utf-8" } }));
    const response = await sessions.request({ launchId, actorId, scopeId, assetPath: "main.js" });
    await response.body?.cancel("client gone");
    expect(cancelled).toHaveBeenCalledWith("client gone");
  });

  it("evicts the least recently used launch and drains its owner session", async () => {
    let sequence = 10;
    const drained: string[] = [];
    const lru = new CollaborativeAppLaunchSessions({
      open: async (identity) => ({
        request: async () => new Response(identity.scopeId, { headers: { "content-type": "text/html; charset=utf-8" } }),
        close: async () => { drained.push(identity.scopeId); },
      }),
      createId: () => `30000000-0000-4000-8000-${String(sequence++).padStart(12, "0")}`,
      now: () => currentTime,
      startTimer: false,
      maxSessions: 2,
      maxPerActor: 2,
    });
    const identity = { actorId, organizationId, runtimeId: "runtime_owner", authorityGeneration: 1,
      appId: app.appId, catalogId: app.catalogId, buildId: app.buildId, shareRevision: 1 };
    const first = await lru.create({ ...identity, scopeId, clientRequestId: "40000000-0000-4000-8000-000000000011" });
    const secondScope = "10000000-0000-4000-8000-000000000002";
    const second = await lru.create({ ...identity, scopeId: secondScope, clientRequestId: "40000000-0000-4000-8000-000000000012" });
    await lru.request({ launchId: first.launchId, actorId, scopeId, assetPath: "index.html" });
    const thirdScope = "10000000-0000-4000-8000-000000000003";
    await lru.create({ ...identity, scopeId: thirdScope, clientRequestId: "40000000-0000-4000-8000-000000000013" });
    expect(lru.describe(first.launchId, actorId, scopeId)).not.toBeNull();
    expect(lru.describe(second.launchId, actorId, secondScope)).toBeNull();
    expect(drained).toEqual([secondScope]);
    await lru.close();
  });

  it("shares one in-flight idempotent open and reserves capacity before awaiting it", async () => {
    let finishOpen!: () => void;
    const opened = vi.fn(async () => {
      await new Promise<void>((resolve) => { finishOpen = resolve; });
      return upstream;
    });
    const bounded = new CollaborativeAppLaunchSessions({
      open: opened,
      now: () => currentTime,
      createId: () => launchId,
      startTimer: false,
      maxSessions: 1,
      maxPerActor: 1,
    });
    const identity = { actorId, scopeId, organizationId, runtimeId: "runtime_owner", authorityGeneration: 1,
      appId: app.appId, catalogId: app.catalogId, buildId: app.buildId, shareRevision: 1 };
    const first = bounded.create({ ...identity, clientRequestId: requestId });
    await vi.waitFor(() => expect(opened).toHaveBeenCalledOnce());
    const replay = bounded.create({ ...identity, clientRequestId: requestId });
    await expect(bounded.create({ ...identity, scopeId: "10000000-0000-4000-8000-000000000002",
      clientRequestId: "40000000-0000-4000-8000-000000000002" })).rejects.toMatchObject({ code: "limit" });
    expect(opened).toHaveBeenCalledOnce();
    finishOpen();
    await expect(Promise.all([first, replay])).resolves.toEqual([
      { launchId, expiresAt: new Date(currentTime + 4 * 60_000).toISOString() },
      { launchId, expiresAt: new Date(currentTime + 4 * 60_000).toISOString() },
    ]);
    await bounded.close();
  });

  it("waits for an in-flight open during close and refuses its late session", async () => {
    let finishOpen!: () => void;
    const lateClose = vi.fn(async () => undefined);
    const draining = new CollaborativeAppLaunchSessions({
      open: async () => {
        await new Promise<void>((resolve) => { finishOpen = resolve; });
        return { request: async () => new Response("late"), close: lateClose };
      },
      startTimer: false,
    });
    const create = draining.create({ actorId, scopeId, organizationId, runtimeId: "runtime_owner",
      authorityGeneration: 1, appId: app.appId, catalogId: app.catalogId, buildId: app.buildId,
      shareRevision: 1, clientRequestId: requestId });
    await vi.waitFor(() => expect(finishOpen).toBeTypeOf("function"));
    const closing = draining.close();
    finishOpen();

    await expect(create).rejects.toMatchObject({ code: "unavailable" });
    await closing;
    expect(lateClose).toHaveBeenCalledOnce();
    expect(draining.size).toBe(0);
  });

  it("rate limits launch creation per authenticated actor", async () => {
    for (let index = 1; index <= 20; index += 1) {
      const response = await routes.request(`/api/collaboration/shared-apps/${scopeId}/launch`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-test-actor": actorId },
        body: JSON.stringify({
          clientRequestId: `41000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
          expectedShareRevision: "1",
          expectedBuildId: app.buildId,
        }),
      });
      expect(response.status).toBe(201);
    }
    const limited = await routes.request(`/api/collaboration/shared-apps/${scopeId}/launch`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-actor": actorId },
      body: JSON.stringify({
        clientRequestId: "41000000-0000-4000-8000-000000000021",
        expectedShareRevision: "1",
        expectedBuildId: app.buildId,
      }),
    });
    expect(limited.status).toBe(429);
  });

  it("drains facade sessions when the stopped directory event commits", async () => {
    await sessions.create({ actorId, clientRequestId: requestId, scopeId, organizationId, runtimeId: "runtime_owner",
      authorityGeneration: 1, appId: app.appId, catalogId: app.catalogId, buildId: app.buildId, shareRevision: 1 });
    const response = await routes.request("/internal/collaboration/directory", {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "x-matrix-runtime-id": "runtime_owner",
        authorization: `Bearer ${"a".repeat(32)}`,
      },
      body: JSON.stringify({
        eventId: "20000000-0000-4000-8000-000000000009",
        scopeId,
        runtimeId: "runtime_owner",
        ownerId: platformCollaborationActors.owner,
        kind: "app",
        organizationId,
        audience: "current_membership",
        authorityGeneration: 1,
        metadataRevision: 9,
        app: { ...app, state: "stopped", shareRevision: 2 },
        recipients: [{ actorId: platformCollaborationActors.owner, status: "revoked" }],
      }),
    });
    expect(response.status).toBe(204);
    expect(sessions.size).toBe(0);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("does not drain a restarted share for a delayed stale stop event", async () => {
    await repository.applyDirectoryEvent({
      eventId: "20000000-0000-4000-8000-000000000010", scopeId, runtimeId: "runtime_owner",
      ownerId: platformCollaborationActors.owner, kind: "app", organizationId, audience: "current_membership",
      authorityGeneration: 1, metadataRevision: 2, app: { ...app, state: "stopped", shareRevision: 2 },
      recipients: [{ actorId: platformCollaborationActors.owner, status: "revoked" }],
    });
    await repository.applyDirectoryEvent({
      eventId: "20000000-0000-4000-8000-000000000011", scopeId, runtimeId: "runtime_owner",
      ownerId: platformCollaborationActors.owner, kind: "app", organizationId, audience: "current_membership",
      authorityGeneration: 1, metadataRevision: 3, app: { ...app, shareRevision: 3 },
      recipients: [{ actorId: platformCollaborationActors.owner, status: "accepted" }],
    });
    await sessions.create({ actorId, clientRequestId: requestId, scopeId, organizationId, runtimeId: "runtime_owner",
      authorityGeneration: 1, appId: app.appId, catalogId: app.catalogId, buildId: app.buildId, shareRevision: 3 });

    const response = await routes.request("/internal/collaboration/directory", {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "x-matrix-runtime-id": "runtime_owner",
        authorization: `Bearer ${"a".repeat(32)}`,
      },
      body: JSON.stringify({
        eventId: "20000000-0000-4000-8000-000000000010", scopeId, runtimeId: "runtime_owner",
        ownerId: platformCollaborationActors.owner, kind: "app", organizationId, audience: "current_membership",
        authorityGeneration: 1, metadataRevision: 2, app: { ...app, state: "stopped", shareRevision: 2 },
        recipients: [{ actorId: platformCollaborationActors.owner, status: "revoked" }],
      }),
    });

    expect(response.status).toBe(204);
    expect(sessions.size).toBe(1);
    expect(close).not.toHaveBeenCalled();
  });
});

describe("collaborative app launch owner-session client", () => {
  it("keeps the proof key server-side and signs every immutable asset request through the relay", async () => {
    const machineId = "11111111-1111-4111-8111-111111111111";
    const enrolledRuntimeId = `vps:${machineId}`;
    const logicalRuntimeId = `vps-${machineId}`;
    const relay = { forward: vi.fn() };
    const issuer = { issue: vi.fn(async ({ actorId: requestedActor, request: raw }: { actorId: string; request: unknown }) => {
      const proofPublicKey = (raw as { proofPublicKey: string }).proofPublicKey;
      return {
        signedTicket: {
          ticket: {
            protocolVersion: 2,
            ticketId: "80000000-0000-4000-8000-000000000001",
            nonce: "a".repeat(64),
            actorId: requestedActor,
            organizationId,
            resource: { scopeId, kind: "app_instance" },
            purpose: "direct_session",
            runtime: { runtimeId: logicalRuntimeId, authorityGeneration: 1 },
            proofKeyThumbprint: proofKeyThumbprint(proofPublicKey),
            maxActions: 100,
            issuedAt: nowDate.toISOString(),
            expiresAt: new Date(nowDate.getTime() + 30_000).toISOString(),
          },
          keyId: "platform-key",
          signature: "s".repeat(86),
        },
        endpoint: { origin: "https://app.matrix-os.com", protocolVersion: 2 },
      };
    }) };
    relay.forward.mockImplementation(async (input: { method: string; path: string; headers: Headers }) => {
      if (input.path === "/api/collaboration/direct-sessions") {
        const thumbprint = (await issuer.issue.mock.results[0]!.value).signedTicket.ticket.proofKeyThumbprint;
        return new Response(JSON.stringify({
          protocolVersion: 2,
          id: "90000000-0000-4000-8000-000000000001",
          actorId,
          organizationId,
          scopeId,
          runtimeId: logicalRuntimeId,
          authorityGeneration: 1,
          purpose: "direct_session",
          proofKeyThumbprint: thumbprint,
          issuedAt: nowDate.toISOString(),
          expiresAt: new Date(nowDate.getTime() + 300_000).toISOString(),
          evidenceExpiresAt: new Date(nowDate.getTime() + 20_000).toISOString(),
          renewAfter: new Date(nowDate.getTime() + 240_000).toISOString(),
        }), { status: 201, headers: { "content-type": "application/json" } });
      }
      if (input.method === "GET") {
        expect(input.headers.get("x-matrix-collaboration-session")).toBe("90000000-0000-4000-8000-000000000001");
        expect(input.headers.get("x-matrix-collaboration-request")).toMatch(/^[A-Za-z0-9_-]+$/);
        expect(input.headers.get("authorization")).toBeNull();
        return new Response("immutable", { headers: { "content-type": "text/javascript; charset=utf-8" } });
      }
      return new Response(null, { status: 204 });
    });
    const open = createCollaborativeAppLaunchUpstreamFactory({
      issuer: issuer as never,
      relay: relay as never,
      clientOrigin: "https://app.matrix-os.com",
      now: () => nowDate,
    });
    const upstreamClient = await open({ actorId, scopeId, organizationId, runtimeId: enrolledRuntimeId,
      authorityGeneration: 1, appId: app.appId, catalogId: app.catalogId, buildId: app.buildId, shareRevision: 1 });
    const response = await upstreamClient.request("assets/main.js", new AbortController().signal);
    expect(await response.text()).toBe("immutable");
    expect(relay.forward).toHaveBeenCalledWith(expect.objectContaining({
      method: "GET",
      path: `/api/collaboration/scopes/${scopeId}/apps/${app.appId}/assets/assets/main.js`,
      responseClass: "app_asset",
    }));
    await upstreamClient.request("assets/team logo?#.png", new AbortController().signal);
    const encodedPath = `/api/collaboration/scopes/${scopeId}/apps/${app.appId}/assets/assets/team%20logo%3F%23.png`;
    const encodedRequest = relay.forward.mock.calls.findLast(([input]) => input.method === "GET")![0];
    expect(encodedRequest.path).toBe(encodedPath);
    const requestProof = JSON.parse(Buffer.from(
      encodedRequest.headers.get("x-matrix-collaboration-request")!, "base64url",
    ).toString("utf8")) as { signature: { path: string } };
    expect(requestProof.signature.path).toBe(encodedPath);
    await upstreamClient.close();
    expect(relay.forward).toHaveBeenCalledWith(expect.objectContaining({ method: "DELETE" }));
  });

  it("owns and safely cancels an in-flight relay body when the caller aborts", async () => {
    const cancelled = vi.fn(async () => undefined);
    const relay = { forward: vi.fn() };
    const issuer = { issue: vi.fn(async ({ actorId: requestedActor, request: raw }: { actorId: string; request: unknown }) => ({
      signedTicket: { ticket: {
        protocolVersion: 2, ticketId: "80000000-0000-4000-8000-000000000002", nonce: "b".repeat(64),
        actorId: requestedActor, organizationId, resource: { scopeId, kind: "app_instance" }, purpose: "direct_session",
        runtime: { runtimeId: "runtime_owner", authorityGeneration: 1 },
        proofKeyThumbprint: proofKeyThumbprint((raw as { proofPublicKey: string }).proofPublicKey), maxActions: 100,
        issuedAt: nowDate.toISOString(), expiresAt: new Date(nowDate.getTime() + 30_000).toISOString(),
      }, keyId: "platform-key", signature: "s".repeat(86) },
      endpoint: { origin: "https://app.matrix-os.com", protocolVersion: 2 },
    })) };
    relay.forward.mockImplementation(async (input: { method: string; path: string }) => {
      if (input.path === "/api/collaboration/direct-sessions") return new Response(JSON.stringify({
        protocolVersion: 2, id: "90000000-0000-4000-8000-000000000002", actorId, organizationId, scopeId,
        runtimeId: "runtime_owner", authorityGeneration: 1, purpose: "direct_session",
        proofKeyThumbprint: (await issuer.issue.mock.results[0]!.value).signedTicket.ticket.proofKeyThumbprint,
        issuedAt: nowDate.toISOString(), expiresAt: new Date(nowDate.getTime() + 300_000).toISOString(),
        evidenceExpiresAt: new Date(nowDate.getTime() + 20_000).toISOString(), renewAfter: new Date(nowDate.getTime() + 240_000).toISOString(),
      }), { status: 201, headers: { "content-type": "application/json" } });
      if (input.method === "GET") return new Response(new ReadableStream<Uint8Array>({
        pull: async () => new Promise<void>(() => undefined),
        cancel: cancelled,
      }), { headers: { "content-type": "text/javascript; charset=utf-8" } });
      return new Response(null, { status: 204 });
    });
    const open = createCollaborativeAppLaunchUpstreamFactory({
      issuer: issuer as never, relay: relay as never, clientOrigin: "https://app.matrix-os.com", now: () => nowDate,
    });
    const upstreamClient = await open({ actorId, scopeId, organizationId, runtimeId: "runtime_owner",
      authorityGeneration: 1, appId: app.appId, catalogId: app.catalogId, buildId: app.buildId, shareRevision: 1 });
    const controller = new AbortController();
    const response = await upstreamClient.request("assets/main.js", controller.signal);
    const reader = response.body!.getReader();
    const reading = reader.read();
    controller.abort(new Error("client gone"));

    await expect(reading).resolves.toMatchObject({ done: true });
    expect(cancelled).toHaveBeenCalledOnce();
  });
});
