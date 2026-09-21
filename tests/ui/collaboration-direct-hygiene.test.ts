/**
 * S06 / T034: session hygiene. Home requests carry no actor token or
 * cookies, failures never log tickets or session ids, nothing is cached so a
 * computer switch cannot serve stale resource content, and the platform is
 * never asked to authorize a scope request.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCollaborationDirectClient } from "../../packages/ui/src/collaboration/direct-client.js";
import { CLIENT_ORIGIN, PLATFORM, RELAY, fakeDirectWorld, scopeId } from "../helpers/collaboration-direct-world.js";

describe("collaboration direct session hygiene", () => {
  let world: ReturnType<typeof fakeDirectWorld>;
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    world = fakeDirectWorld();
    warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => { warn.mockRestore(); });

  const client = () => createCollaborationDirectClient({
    platformBaseUrl: PLATFORM, fetchImpl: world.fetchImpl, webSocketFactory: world.webSocketFactory, clientOrigin: CLIENT_ORIGIN, now: world.now,
    getHeaders: async () => ({ Authorization: "Bearer actor-token" }),
  });

  it("never sends the actor token or cookies to a home and never sends home credentials to the platform", async () => {
    const direct = client();
    await direct.request(scopeId, "GET", `/api/collaboration/scopes/${scopeId}`);
    for (const [url, init] of world.fetchImpl.mock.calls) {
      const target = new URL(String(url));
      const headers = new Headers(init?.headers);
      if (target.origin === RELAY) {
        expect(headers.get("authorization")).toBeNull();
        expect(headers.get("cookie")).toBeNull();
        expect(init?.credentials).toBe("omit");
      } else {
        expect(target.origin).toBe(PLATFORM);
        expect(headers.get("x-matrix-collaboration-session")).toBeNull();
        expect(headers.get("x-matrix-collaboration-request")).toBeNull();
      }
    }
  });

  it("does not log tickets, nonces or session ids when a home rejects the client", async () => {
    const direct = client();
    await direct.request(scopeId, "GET", `/api/collaboration/scopes/${scopeId}`);
    const ticket = world.platform.tickets[0]!;
    const sessionId = world.home.requests[1]!.headers.get("x-matrix-collaboration-session")!;
    world.home.generation = 9;
    world.platform.offlineScopes.add(scopeId);
    await expect(direct.request(scopeId, "GET", `/api/collaboration/scopes/${scopeId}`)).rejects.toMatchObject({ code: "host_offline" });
    const logged = warn.mock.calls.map((call) => call.map(String).join(" ")).join("\n");
    expect(logged).not.toContain(String(ticket.nonce));
    expect(logged).not.toContain(sessionId);
    expect(logged).not.toContain("Bearer");
  });

  it("keeps no resource cache, so a computer switch always re-reads from the scope's home", async () => {
    const direct = client();
    const first = await direct.request(scopeId, "GET", `/api/collaboration/scopes/${scopeId}/chat`);
    const second = await direct.request(scopeId, "GET", `/api/collaboration/scopes/${scopeId}/chat`);
    expect(first).toEqual(second);
    const reads = world.home.requests.filter((request) => request.url.endsWith(`/scopes/${scopeId}/chat`));
    expect(reads).toHaveLength(2);
    // A second client for another selected computer starts from a fresh session on the same home.
    const other = client();
    await other.request(scopeId, "GET", `/api/collaboration/scopes/${scopeId}/chat`);
    expect(world.home.sessions.size).toBe(2);
    expect(other.describe(scopeId).origin).toBe(RELAY);
  });

  it("never asks the platform to authorize or serve a scope request", async () => {
    const direct = client();
    await direct.request(scopeId, "POST", `/api/collaboration/scopes/${scopeId}/chat/messages`, { text: "hello" });
    const platformCalls = world.fetchImpl.mock.calls.filter(([url]) => new URL(String(url)).origin === PLATFORM);
    expect(platformCalls.every(([url]) => new URL(String(url)).pathname === "/api/collaboration/connections")).toBe(true);
  });
});
