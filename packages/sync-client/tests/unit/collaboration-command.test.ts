import { afterEach, describe, expect, it, vi } from "vitest";
import { collaborationDiscoveryPath, collaborationRequest } from "../../src/cli/commands/collaboration.js";

describe("collaboration CLI transport", () => {
  afterEach(() => vi.restoreAllMocks());

  it("keeps participant requests on the authenticated platform boundary", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ items: [] }), {
      headers: { "content-type": "application/json" },
    }));
    await expect(collaborationRequest({
      platformUrl: "https://app.matrix-os.com", token: "actor-token", method: "GET", path: "/api/collaboration/shared",
    })).resolves.toEqual({ items: [] });
    expect(fetchMock).toHaveBeenCalledWith("https://app.matrix-os.com/api/collaboration/shared", expect.objectContaining({
      headers: expect.objectContaining({ Authorization: "Bearer actor-token" }),
      redirect: "error", signal: expect.any(AbortSignal),
    }));
  });

  it("rejects non-collaboration paths before transport", async () => {
    await expect(collaborationRequest({
      platformUrl: "https://app.matrix-os.com", token: "actor-token", method: "GET", path: "/api/files/private",
    })).rejects.toMatchObject({ code: "collaboration_failed" });
  });

  it("sends shared project content to the signed home transport", async () => {
    const path = "/api/collaboration/scopes/10000000-0000-4000-8000-000000000001/project";
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const request = vi.fn(async () => ({ id: "project_launch" }));

    await expect(collaborationRequest({
      platformUrl: "https://app.matrix-os.com", token: "actor-token", method: "GET", path,
      transport: { request } as never,
    })).resolves.toEqual({ id: "project_launch" });
    expect(request).toHaveBeenCalledWith("10000000-0000-4000-8000-000000000001", "GET", path, undefined);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    "/api/collaboration/scopes/10000000-0000-4000-8000-000000000001/chat/requests",
    "/api/collaboration/scopes/10000000-0000-4000-8000-000000000001/chat/requests/qturn_one/cancel",
    "/api/collaboration/scopes/10000000-0000-4000-8000-000000000001/chat/requests/qturn_one/retry",
    "/api/collaboration/scopes/10000000-0000-4000-8000-000000000001/chat/approvals/approval_one/decision",
  ])("keeps M2 controls on the scoped home route %s", async (path) => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const request = vi.fn(async () => ({ ok: true }));
    await expect(collaborationRequest({
      platformUrl: "https://app.matrix-os.com", token: "actor-token", method: "POST", path, body: {},
      transport: { request } as never,
    })).resolves.toEqual({ ok: true });
    expect(request).toHaveBeenCalledWith("10000000-0000-4000-8000-000000000001", "POST", path, {});
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockRestore();
  });

  it("resolves only an indexed invitation scope pointer on platform before home content", async () => {
    const scopeId = "10000000-0000-4000-8000-000000000001";
    const path = "/api/collaboration/invitations/30000000-0000-4000-8000-000000000001";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ scopeId }));
    const request = vi.fn(async () => ({ id: "invitation" }));
    await expect(collaborationRequest({ platformUrl: "https://app.matrix-os.com", token: "actor-token",
      method: "GET", path, transport: { request } as never })).resolves.toEqual({ id: "invitation" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`https://app.matrix-os.com${path}/location`);
    expect(request).toHaveBeenCalledWith(scopeId, "GET", path, undefined);
  });

  it("builds bounded opaque discovery page paths", () => {
    expect(collaborationDiscoveryPath("inbox", { limit: "25", cursor: "opaque/+ cursor" })).toBe(
      "/api/collaboration/inbox?limit=25&cursor=opaque%2F%2B+cursor",
    );
    expect(() => collaborationDiscoveryPath("shared", { limit: "0" })).toThrowError();
    expect(() => collaborationDiscoveryPath("shared", { cursor: "x".repeat(513) })).toThrowError();
  });
});
