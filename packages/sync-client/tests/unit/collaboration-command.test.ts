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

  it.each([
    "/api/collaboration/scopes/10000000-0000-4000-8000-000000000001/chat/requests",
    "/api/collaboration/scopes/10000000-0000-4000-8000-000000000001/chat/requests/qturn_one/cancel",
    "/api/collaboration/scopes/10000000-0000-4000-8000-000000000001/chat/requests/qturn_one/retry",
    "/api/collaboration/scopes/10000000-0000-4000-8000-000000000001/chat/approvals/approval_one/decision",
  ])("keeps M2 controls on the scoped platform route %s", async (path) => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ ok: true }), {
      headers: { "content-type": "application/json" },
    }));
    await expect(collaborationRequest({
      platformUrl: "https://app.matrix-os.com", token: "actor-token", method: "POST", path, body: {},
    })).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining(path), expect.objectContaining({
      method: "POST",
      redirect: "error",
      signal: expect.any(AbortSignal),
    }));
    fetchMock.mockRestore();
  });

  it("builds bounded opaque discovery page paths", () => {
    expect(collaborationDiscoveryPath("inbox", { limit: "25", cursor: "opaque/+ cursor" })).toBe(
      "/api/collaboration/inbox?limit=25&cursor=opaque%2F%2B+cursor",
    );
    expect(() => collaborationDiscoveryPath("shared", { limit: "0" })).toThrowError();
    expect(() => collaborationDiscoveryPath("shared", { cursor: "x".repeat(513) })).toThrowError();
  });
});
