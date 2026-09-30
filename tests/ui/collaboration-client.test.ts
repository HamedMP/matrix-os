import { describe, expect, it, vi } from "vitest";
import { createCollaborationBrowserApi } from "../../packages/ui/src/collaboration/client.js";
import { classifyCollaborationClientError } from "../../packages/ui/src/collaboration/failure-classification.js";

describe("collaboration browser client", () => {
  it("preserves only a bounded stable platform failure code for recipient copy", async () => {
    const api = createCollaborationBrowserApi({
      baseUrl: "https://app.matrix-os.com",
      fetchImpl: async () => new Response(JSON.stringify({ error: "postgres://secret", code: "host_offline" }),
        { status: 503, headers: { "content-type": "application/json" } }),
    });
    const error = await api.get("/api/collaboration/shared").catch((failure: unknown) => failure);
    expect(classifyCollaborationClientError(error)).toMatchObject({ state: "host_offline", reconnect: true });
    expect(String(error)).not.toContain("postgres://secret");
  });

  it("uses exact bounded requests and caller-provided actor authentication", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
      headers: { "content-type": "application/json", "content-length": "11" },
    }));
    const api = createCollaborationBrowserApi({
      baseUrl: "https://app.matrix-os.com",
      fetchImpl,
      getHeaders: async () => ({ Authorization: "Bearer actor-token" }),
    });
    await expect(api.post("/api/collaboration/scopes/10000000-0000-4000-8000-000000000001/chat/messages", { text: "hello" }))
      .resolves.toEqual({ ok: true });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://app.matrix-os.com/api/collaboration/scopes/10000000-0000-4000-8000-000000000001/chat/messages");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer actor-token");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    await expect(api.get("/api/private/files")).rejects.toThrow("CollaborationUnavailable");
  });

  it("rejects oversized responses before parsing them", async () => {
    const api = createCollaborationBrowserApi({
      baseUrl: "https://app.matrix-os.com",
      fetchImpl: async () => new Response("x".repeat(2 * 1024 * 1024 + 1)),
    });
    await expect(api.get("/api/collaboration/shared")).rejects.toThrow("CollaborationUnavailable");
  });

  it("sends DELETE conditions as allowlisted headers without a request body", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ status: "revoked" }), {
      headers: { "content-type": "application/json" },
    }));
    const api = createCollaborationBrowserApi({ baseUrl: "https://app.matrix-os.com", fetchImpl });
    await api.delete(
      "/api/collaboration/scopes/10000000-0000-4000-8000-000000000001/members/user_editor",
      {
        clientRequestId: "40000000-0000-4000-8000-000000000001",
        expectedRevision: "3",
        expectedMemberRevision: "2",
      },
    );
    const [, init] = fetchImpl.mock.calls[0]!;
    expect(init?.body).toBeUndefined();
    expect(new Headers(init?.headers).get("x-matrix-client-request-id"))
      .toBe("40000000-0000-4000-8000-000000000001");
  });

  it("carries no realtime streams and refuses the retired V1 connection-ticket route", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
      headers: { "content-type": "application/json" },
    }));
    const api = createCollaborationBrowserApi({ baseUrl: "https://app.matrix-os.com", fetchImpl });
    // Event and terminal sockets exist only on the direct transport (direct-api.ts).
    expect(api.subscribe).toBeUndefined();
    expect(api.subscribeTerminal).toBeUndefined();
    await expect(api.post(
      "/api/collaboration/scopes/10000000-0000-4000-8000-000000000001/connection-tickets",
      { clientRequestId: "40000000-0000-4000-8000-000000000001", purpose: "events" },
    )).rejects.toThrow("CollaborationUnavailable");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("collaboration browser client organization directory reads", () => {
  const ok = () => vi.fn(async () => new Response(JSON.stringify({ organizations: [] }), {
    headers: { "content-type": "application/json" },
  }));

  it("reads the organization listing and member pages with the platform credentials", async () => {
    const fetchImpl = ok();
    const api = createCollaborationBrowserApi({
      baseUrl: "https://app.matrix-os.com",
      fetchImpl,
      getHeaders: async () => ({ Authorization: "Bearer actor-token" }),
    });
    await api.get("/api/organizations");
    await api.get("/api/organizations/org_alpha/members");
    await api.get(`/api/organizations/${encodeURIComponent("org_alpha")}/members?cursor=dXNlcl9tZW1iZXI_-`);
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      "https://app.matrix-os.com/api/organizations",
      "https://app.matrix-os.com/api/organizations/org_alpha/members",
      "https://app.matrix-os.com/api/organizations/org_alpha/members?cursor=dXNlcl9tZW1iZXI_-",
    ]);
    for (const [, init] of fetchImpl.mock.calls) {
      expect(init).toMatchObject({ method: "GET", credentials: "same-origin", redirect: "error" });
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer actor-token");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it.each([
    ["a mutation of the listing", "post", "/api/organizations"],
    ["a mutation of a member page", "patch", "/api/organizations/org_alpha/members"],
    ["a delete of a member page", "delete", "/api/organizations/org_alpha/members"],
    ["a listing query", "get", "/api/organizations?limit=5"],
    ["a trailing slash", "get", "/api/organizations/"],
    ["an organization read", "get", "/api/organizations/org_alpha"],
    ["a member subresource", "get", "/api/organizations/org_alpha/members/user_member"],
    ["a malformed organization", "get", "/api/organizations/team_alpha/members"],
    ["an encoded separator", "get", "/api/organizations/org_alpha%2Fmembers/members"],
    ["a traversal", "get", "/api/organizations/org_alpha/../members"],
    ["a sibling prefix", "get", "/api/organizationsx"],
    ["a limit parameter", "get", "/api/organizations/org_alpha/members?limit=100"],
    ["a repeated cursor", "get", "/api/organizations/org_alpha/members?cursor=a&cursor=b"],
    ["an empty cursor", "get", "/api/organizations/org_alpha/members?cursor="],
    ["a malformed cursor", "get", "/api/organizations/org_alpha/members?cursor=a%20b"],
    ["an oversized cursor", "get", `/api/organizations/org_alpha/members?cursor=${"a".repeat(257)}`],
    ["a fragment", "get", "/api/organizations#members"],
    ["another origin", "get", "https://evil.example/api/organizations"],
    ["a protocol-relative origin", "get", "//evil.example/api/organizations"],
    ["another platform route", "get", "/api/runtimes"],
  ] as const)("refuses %s before any request", async (_label, method, path) => {
    const fetchImpl = ok();
    const api = createCollaborationBrowserApi({ baseUrl: "https://app.matrix-os.com", fetchImpl });
    const call = method === "get" ? api.get(path) : method === "post" ? api.post(path, {}) : method === "patch" ? api.patch!(path, {})
      : api.delete(path, { clientRequestId: "40000000-0000-4000-8000-000000000001", expectedRevision: "1", expectedMemberRevision: "1" });
    await expect(call).rejects.toThrow("CollaborationUnavailable");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
