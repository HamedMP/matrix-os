/**
 * Spec 535 B6a: shared file bytes come from the resource's home through a
 * signed request, bounded in memory, and never parsed as JSON.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CollaborationDirectError, createCollaborationDirectClient } from "../../packages/ui/src/collaboration/direct-client.js";
import { createCollaborationDirectApi } from "../../packages/ui/src/collaboration/direct-api.js";
import { CLIENT_ORIGIN, PLATFORM, RELAY, fakeDirectWorld, scopeId } from "../helpers/collaboration-direct-world.js";

const fileId = "20000000-0000-4000-8000-000000000001";
const contentPath = `/api/collaboration/scopes/${scopeId}/files/${fileId}/content`;
const appAssetPath = `/api/collaboration/scopes/${scopeId}/apps/notes/assets/index.html`;

describe("collaboration direct content", () => {
  let world: ReturnType<typeof fakeDirectWorld>;
  let respond: () => Response;
  let contentRequests: Array<{ headers: Headers; url: string }>;

  beforeEach(() => {
    world = fakeDirectWorld();
    contentRequests = [];
    respond = () => new Response(new TextEncoder().encode("hello file"), {
      status: 200, headers: { "content-type": "text/markdown", "content-length": "10" },
    });
  });

  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if ((url.origin === RELAY || url.origin === PLATFORM) && (url.pathname === contentPath || url.pathname === appAssetPath)) {
      const headers = new Headers(init?.headers);
      contentRequests.push({ headers, url: url.href });
      const sessionId = headers.get("x-matrix-collaboration-session");
      if (!sessionId || !world.home.sessions.has(sessionId)) return new Response(null, { status: 401 });
      return respond();
    }
    return world.fetchImpl(input, init);
  });

  const client = () => createCollaborationDirectClient({
    platformBaseUrl: PLATFORM, fetchImpl: fetchImpl as unknown as typeof fetch, webSocketFactory: world.webSocketFactory,
    clientOrigin: CLIENT_ORIGIN, now: world.now, getHeaders: async () => ({ Authorization: "Bearer actor-token" }),
  });

  it("reads bytes with a signed request to the home and keeps the content type", async () => {
    const result = await client().requestContent(scopeId, contentPath, { maxBytes: 1024 });

    expect(result).toMatchObject({ status: "ok", contentType: "text/markdown", size: 10 });
    expect(result.status === "ok" && new TextDecoder().decode(result.bytes)).toBe("hello file");
    const request = contentRequests.at(-1)!;
    expect(request.url).toBe(`${RELAY}${contentPath}`);
    expect(request.headers.get("x-matrix-collaboration-session")).toMatch(/^[0-9a-f-]{36}$/);
    expect(request.headers.get("x-matrix-collaboration-request")).toBeTruthy();
    expect(request.headers.get("authorization")).toBeNull();
  });

  it("reads only bounded assets of the exact scoped app", async () => {
    const direct = client();
    await expect(direct.requestContent(scopeId, appAssetPath, { maxBytes: 1024 })).resolves.toMatchObject({ status: "ok", size: 10 });
    expect(contentRequests.at(-1)?.url).toBe(`${RELAY}${appAssetPath}`);
    for (const path of [
      `/api/collaboration/scopes/${scopeId}/apps/notes/assets/../private`,
      `/api/collaboration/scopes/${scopeId}/apps/notes/assets/.env`,
      `/api/collaboration/scopes/${scopeId}/apps/notes/assets/`,
      `/api/collaboration/scopes/${scopeId}/apps/notes/assets/main.js?x=1`,
    ]) await expect(direct.requestContent(scopeId, path, { maxBytes: 1024 })).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("stops at the declared size without reading the body", async () => {
    const cancel = vi.fn();
    respond = () => {
      const body = new ReadableStream<Uint8Array>({ cancel });
      return new Response(body, { status: 200, headers: { "content-type": "application/pdf", "content-length": "5000" } });
    };

    await expect(client().requestContent(scopeId, contentPath, { maxBytes: 1024 })).resolves.toEqual({ status: "too_large", size: 5000 });
    expect(cancel).toHaveBeenCalled();
  });

  it("stops reading an undeclared body once it passes the limit", async () => {
    respond = () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(800));
        controller.enqueue(new Uint8Array(800));
        controller.close();
      },
    }), { status: 200, headers: { "content-type": "text/plain" } });

    await expect(client().requestContent(scopeId, contentPath, { maxBytes: 1024 })).resolves.toEqual({ status: "too_large", size: null });
  });

  it("reports a response the relay refused as too large", async () => {
    respond = () => new Response(JSON.stringify({ error: "Collaboration response too large", code: "too_large" }), {
      status: 503, headers: { "content-type": "application/json" },
    });
    await expect(client().requestContent(scopeId, contentPath, { maxBytes: 1024 })).resolves.toEqual({ status: "too_large", size: null });
    respond = () => new Response(JSON.stringify({ error: "Collaboration unavailable" }), { status: 503, headers: { "content-type": "application/json" } });
    await expect(client().requestContent(scopeId, contentPath, { maxBytes: 1024 })).rejects.toMatchObject({ code: "unavailable" });
  });

  it("falls back to a generic type for a malformed content type", async () => {
    respond = () => new Response("x", { status: 200, headers: { "content-type": "text/html; <script>" } });
    await expect(client().requestContent(scopeId, contentPath, { maxBytes: 1024 })).resolves.toMatchObject({ contentType: "text/html" });
    respond = () => new Response("x", { status: 200, headers: { "content-type": "not a type" } });
    await expect(client().requestContent(scopeId, contentPath, { maxBytes: 1024 })).resolves.toMatchObject({ contentType: "application/octet-stream" });
  });

  it("maps home failures to safe typed errors", async () => {
    respond = () => new Response(JSON.stringify({ error: "Collaboration resource not found", code: "not_found" }), { status: 404, headers: { "content-type": "application/json" } });
    await expect(client().requestContent(scopeId, contentPath, { maxBytes: 1024 })).rejects.toMatchObject({ code: "access_removed" });
    world.platform.offlineScopes.add(scopeId);
    const offline = client();
    await expect(offline.requestContent(scopeId, contentPath, { maxBytes: 1024 })).rejects.toMatchObject({ code: "host_offline" });
  });

  it.each([[503, "host_offline", "host_offline"], [423, "paused", "paused"], [429, "relay_limit", "relay_limit"]] as const)("classifies typed %s content failures", async (status, code, expected) => {
    respond = () => new Response(JSON.stringify({ error: "Collaboration unavailable", code }), { status, headers: { "content-type": "application/json" } });
    await expect(client().requestContent(scopeId, contentPath, { maxBytes: 1024 })).rejects.toMatchObject({ code: expected });
  });

  it("keeps the home session when the platform challenges a content request", async () => {
    world = fakeDirectWorld({ endpointOrigin: PLATFORM });
    respond = () => new Response(JSON.stringify({ error: "Sign in required", code: "unauthorized" }), { status: 401, headers: { "content-type": "application/json", "www-authenticate": "Bearer realm=\"matrix-platform\"" } });
    const direct = client();
    await expect(direct.requestContent(scopeId, contentPath, { maxBytes: 1024 })).rejects.toMatchObject({ code: "unauthenticated" });
    expect(contentRequests).toHaveLength(1);
    expect(direct.describe(scopeId).state).toBe("unauthenticated");
  });

  it("refuses content paths outside the scope and invalid limits", async () => {
    const direct = client();
    for (const path of [
      "/api/collaboration/scopes/10000000-0000-4000-8000-000000000002/files/x/content",
      `/api/collaboration/scopes/${scopeId}/../other/content`,
      `/api/collaboration/scopes/${scopeId}/files/${fileId}`,
    ]) {
      await expect(direct.requestContent(scopeId, path, { maxBytes: 1024 })).rejects.toBeInstanceOf(CollaborationDirectError);
    }
    await expect(direct.requestContent(scopeId, contentPath, { maxBytes: 0 })).rejects.toMatchObject({ code: "invalid_request" });
    await expect(direct.requestContent(scopeId, contentPath, { maxBytes: 64 * 1024 * 1024 })).rejects.toMatchObject({ code: "invalid_request" });
    expect(contentRequests).toEqual([]);
  });

  it("is exposed on the direct API for scope content paths only", async () => {
    const api = createCollaborationDirectApi({
      platformBaseUrl: PLATFORM, fetchImpl: fetchImpl as unknown as typeof fetch, webSocketFactory: world.webSocketFactory,
      clientOrigin: CLIENT_ORIGIN, now: world.now, getHeaders: async () => ({ Authorization: "Bearer actor-token" }),
    });

    await expect(api.getContent(contentPath, { maxBytes: 1024 })).resolves.toMatchObject({ status: "ok", size: 10 });
    await expect(api.getContent("/api/collaboration/inbox", { maxBytes: 1024 })).rejects.toThrow("CollaborationUnavailable");
    respond = () => new Response(JSON.stringify({ error: "Not found", code: "not_found" }), { status: 404, headers: { "content-type": "application/json" } });
    const failure = await api.getContent(contentPath, { maxBytes: 1024 }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("CollaborationUnavailable");
    expect((failure as Error & { cause: unknown }).cause).toMatchObject({ code: "access_removed" });
  });
});
