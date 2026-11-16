import { afterEach, describe, expect, it, vi } from "vitest";
import { CollaborationDiscoveryResponseSchema } from "@matrix-os/contracts";
import { createCollaborationDirectApi } from "../../packages/ui/src/collaboration/direct-api.js";
import { CLIENT_ORIGIN, PLATFORM, fakeDirectWorld, runtimeId, scopeId } from "../helpers/collaboration-direct-world.js";

describe("standalone resource discovery", () => {
  afterEach(() => vi.useRealTimers());

  it.each(["accepted", "invited"])("retains a pre-organization %s Chat without attempting a connection on refresh", async status => {
    const world = fakeDirectWorld();
    const item = { scopeId, runtimeId, ownerId: "user_owner", kind: "chat", authorityGeneration: 1,
      status, ...(status === "invited" ? { invitationId: "20000000-0000-4000-8000-000000000001" } : {}) };
    const kind = status === "accepted" ? "shared" : "inbox";
    world.platform[kind] = [item];
    const api = createCollaborationDirectApi({ platformBaseUrl: PLATFORM, fetchImpl: world.fetchImpl,
      clientOrigin: CLIENT_ORIGIN, now: world.now });
    try {
      for (let refresh = 0; refresh < 3; refresh++) {
        const page = await api.get(`/api/collaboration/${kind}`) as { items: unknown[] };
        expect(page.items).toEqual([{ ...item, home: "denied" }]);
        expect(CollaborationDiscoveryResponseSchema.safeParse(page).success).toBe(true);
        world.advance(30_000);
      }
      expect(world.fetchImpl.mock.calls.map(([url]) => new URL(String(url)).pathname))
        .toEqual(Array(3).fill(`/api/collaboration/${kind}`));
      expect(world.home.requests).toEqual([]);
    } finally { api.direct.close(); }
  });

  it("still reads an existing standalone Chat with organization authorization", async () => {
    const world = fakeDirectWorld();
    world.platform.shared = [{ scopeId, runtimeId, ownerId: "user_owner", kind: "chat", authorityGeneration: 3,
      status: "accepted", organizationId: "org_direct_1" }];
    const api = createCollaborationDirectApi({ platformBaseUrl: PLATFORM, fetchImpl: world.fetchImpl,
      clientOrigin: CLIENT_ORIGIN, now: world.now });
    try {
      const page = await api.get("/api/collaboration/shared");
      expect(page).toMatchObject({ items: [{ scopeId, resource: { chat: { title: "Design review" } } }] });
      expect(await api.get(`/api/collaboration/scopes/${scopeId}/chat`)).toMatchObject({ title: "Design review" });
    } finally { api.direct.close(); }
  });

  it("reports a missing connection as unavailable access rather than an offline owner", async () => {
    const world = fakeDirectWorld();
    world.platform.shared = [{ scopeId, runtimeId, ownerId: "user_owner", kind: "chat", authorityGeneration: 3,
      status: "accepted", organizationId: "org_direct_1" }];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) =>
      new URL(String(input)).pathname === "/api/collaboration/connections"
        ? new Response(null, { status: 404 }) : world.fetchImpl(input, init));
    const api = createCollaborationDirectApi({ platformBaseUrl: PLATFORM, fetchImpl,
      clientOrigin: CLIENT_ORIGIN, now: world.now });
    try {
      expect(await api.get("/api/collaboration/shared")).toMatchObject({ items: [{ scopeId, home: "denied" }] });
      expect(api.direct.describe(scopeId).state).toBe("denied");
      expect(world.home.requests).toEqual([]);
    } finally { api.direct.close(); }
  });

  it.each([401, 403, 404].flatMap(status => (["events", "terminal"] as const).map(kind => ({ status, kind }))))(
    "stops $kind connection retries after an HTTP $status access failure", async ({ status, kind }) => {
      vi.useFakeTimers();
      const world = fakeDirectWorld();
      const connections = vi.fn(async () => new Response(null, { status }));
      const api = createCollaborationDirectApi({ platformBaseUrl: PLATFORM, fetchImpl: connections,
        clientOrigin: CLIENT_ORIGIN, now: world.now });
      const unavailable = vi.fn();
      try {
        const stop = kind === "events"
          ? api.direct.subscribeEvents(scopeId, { onEvent: vi.fn(), onUnavailable: unavailable })
          : api.direct.subscribeTerminal(scopeId, { onReady: vi.fn(), onOutput: vi.fn(), onState: vi.fn(),
            onRefreshRequired: vi.fn(), onUnavailable: unavailable, onDisconnected: vi.fn() });
        await vi.waitFor(() => expect(connections).toHaveBeenCalled());
        await vi.advanceTimersByTimeAsync(60_000);
        expect(connections).toHaveBeenCalledTimes(1);
        expect(unavailable).toHaveBeenCalledTimes(1);
        stop();
      } finally { api.direct.close(); }
  });

  it("still reconnects when an initially offline owner becomes available", async () => {
    vi.useFakeTimers();
    const world = fakeDirectWorld();
    world.platform.offlineScopes.add(scopeId);
    const api = createCollaborationDirectApi({ platformBaseUrl: PLATFORM, fetchImpl: world.fetchImpl,
      webSocketFactory: world.webSocketFactory, clientOrigin: CLIENT_ORIGIN, now: world.now });
    const unavailable = vi.fn();
    try {
      api.direct.subscribeEvents(scopeId, { onEvent: vi.fn(), onUnavailable: unavailable });
      await vi.waitFor(() => expect(world.fetchImpl).toHaveBeenCalled());
      world.platform.offlineScopes.delete(scopeId);
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.waitFor(() => expect(world.sockets).toHaveLength(1));
      expect(unavailable).not.toHaveBeenCalled();
    } finally { api.direct.close(); }
  });

  it.each(["folder", "file", "app"])("keeps accepted %s metadata for its resource-specific reader", async kind => {
    const world = fakeDirectWorld();
    const item = { scopeId, runtimeId, ownerId: "user_owner", kind, authorityGeneration: 3,
      status: "accepted", organizationId: "org_direct_1" };
    world.platform.shared = [item];
    const api = createCollaborationDirectApi({ platformBaseUrl: PLATFORM, fetchImpl: world.fetchImpl,
      clientOrigin: CLIENT_ORIGIN, now: world.now });
    try {
      const result = await api.get("/api/collaboration/shared");
      // Folder/file/app readers authorize and hydrate their own content. Discovery must not
      // call the Chat adapter, which reports an unavailable Chat for a healthy folder.
      expect(world.home.requests).toEqual([]);
      expect(CollaborationDiscoveryResponseSchema.parse(result)).toEqual({ items: [item] });
    } finally {
      api.direct.close();
    }
  });
});
