// @vitest-environment jsdom
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { CanonicalChatNavigationResponseSchema } from "@matrix-os/contracts";
import { clearChatNavigationScopes } from "@matrix-os/ui";
import { createCanonicalChatRoutes, type CanonicalChatRouteService } from "../../packages/gateway/src/chat/routes.js";
import { createApiClient } from "../../desktop/src/renderer/src/lib/api.js";
import { createCanonicalChatClient } from "../../desktop/src/renderer/src/lib/canonical-chat-client.js";
import { createCanonicalShellChatClient } from "../../shell/src/lib/canonical-chat-client.js";
import { useWorkNavigation } from "../../desktop/src/renderer/src/features/work/use-work-navigation.js";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection.js";

const empty = { version: 1 as const, items: [], truncated: false };
function transport(app: Hono) {
  const requests: URL[] = [];
  const fetchFn = vi.fn(async (input: string, init?: RequestInit) => {
    requests.push(new URL(input));
    return app.request(input, init);
  });
  return { requests, fetchFn, client: createCanonicalChatClient(createApiClient({
    baseUrl: "https://matrix.test", getRuntimeSlot: () => "primary", fetchFn,
  })) };
}
beforeEach(() => {
  clearChatNavigationScopes();
  useConnection.setState(useConnection.getInitialState(), true);
});
afterEach(() => { cleanup(); clearChatNavigationScopes(); });

describe("navigation through the actual runtime transport", () => {
  it("accepts one Desktop navigation request without Chat funding negotiation", async () => {
    const navigation = vi.fn(async () => empty);
    const app = createCanonicalChatRoutes({ service: { navigation } as unknown as CanonicalChatRouteService,
      getPrincipal: () => ({ userId: "navigation_owner", source: "jwt" }) });
    const { client, requests } = transport(app);
    expect(CanonicalChatNavigationResponseSchema.parse(await client.navigation!())).toEqual(empty);
    expect(requests.map(url => url.pathname + url.search)).toEqual(["/api/chat-navigation?version=1&limit=1000"]);
    expect(requests[0]!.searchParams.has("fundingVersion")).toBe(false);
    expect(navigation).toHaveBeenCalledExactlyOnceWith({ type: "personal", ownerId: "navigation_owner" }, { version: 1, limit: 1000 });
  });
  it("uses the same independent versioned endpoint from Web", async () => {
    const app = createCanonicalChatRoutes({ service: { navigation: async () => empty } as unknown as CanonicalChatRouteService,
      getPrincipal: () => ({ userId: "navigation_owner", source: "jwt" }) });
    const { fetchFn, requests } = transport(app);
    const client = createCanonicalShellChatClient({ gatewayUrl: "https://matrix.test", fetchFn });
    expect(await client.navigation!()).toEqual(empty);
    expect(requests.map(url => url.pathname + url.search)).toEqual(["/api/chat-navigation?version=1&limit=1000"]);
  });
  it("reaches the existing legacy loader only for a confirmed unsupported 404", async () => {
    const app = new Hono();
    app.get("/api/chats", context => context.json({ items: [] }));
    app.get("/api/chat-agents", context => context.json({ enabled: true, agents: [] }));
    // Older gateways treat an unrecognized literal under /chats as an invalid Chat ID.
    app.get("/api/chats/:chatId", context => context.json({ error: "Invalid request" }, 400));
    const { client, requests } = transport(app);
    const hook = renderHook(() => useWorkNavigation(client, undefined, true));
    await waitFor(() => expect(hook.result.current.fresh).toBe(true));
    expect(requests.map(url => url.pathname)).toEqual(["/api/chat-navigation", "/api/chats", "/api/chat-agents"]);
    expect(hook.result.current.error).toBeNull();
  });
  it.each([400, 401, 403, 429, 503] as const)("does not fall back for HTTP %i", async status => {
    const app = new Hono();
    app.get("/api/chat-navigation", context => context.json({ error: "Request failed" }, status));
    app.get("/api/chats/:chatId", context => context.json({ error: "Request failed" }, status));
    const { client, requests } = transport(app);
    const hook = renderHook(() => useWorkNavigation(client, undefined, true));
    await waitFor(() => expect(hook.result.current.status).toBe("error"));
    expect(requests).toHaveLength(1);
    expect(hook.result.current.items).toEqual([]);
    expect(hook.result.current.fresh).toBe(false);
  });
});
