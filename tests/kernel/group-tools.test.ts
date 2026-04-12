import { describe, it, expect, vi, beforeEach } from "vitest";
import type { GatewayFetcher, GatewayFetchResponse } from "../../packages/kernel/src/tools/integrations.js";

// Imports will fail until group-tools.ts is created (T022) — that's the Red phase.
import {
  createGroupHandler,
  joinGroupHandler,
  listGroupsHandler,
  leaveGroupHandler,
} from "../../packages/kernel/src/group-tools.js";

function makeOkResponse(body: unknown, status = 200): GatewayFetchResponse {
  return {
    ok: true,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function makeErrorResponse(status: number, body: unknown = { error: "gateway error" }): GatewayFetchResponse {
  return {
    ok: false,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function makeFetcher(response: GatewayFetchResponse): GatewayFetcher {
  return vi.fn().mockResolvedValue(response);
}

type MockFetcher = ReturnType<typeof vi.fn>;

describe("group lifecycle IPC tools", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // ---------------------------------------------------------------------------
  // create_group
  // ---------------------------------------------------------------------------
  describe("createGroupHandler", () => {
    it("calls POST /api/groups with name and member_handles", async () => {
      const fetcher = makeFetcher(makeOkResponse({ slug: "test-fam", room_id: "!abc:matrix-os.com" }, 201));
      await createGroupHandler({ name: "Test Fam", member_handles: ["@bob:matrix-os.com"] }, fetcher);

      const [url, init] = (fetcher as MockFetcher).mock.calls[0] as [string, RequestInit];
      expect(url).toMatch(/\/api\/groups$/);
      expect((init as { method: string }).method).toBe("POST");
      const body = JSON.parse((init as { body: string }).body);
      expect(body).toEqual({ name: "Test Fam", member_handles: ["@bob:matrix-os.com"] });
    });

    it("returns IPC content array with slug and room_id on success", async () => {
      const fetcher = makeFetcher(makeOkResponse({ slug: "test-fam", room_id: "!abc:matrix-os.com" }, 201));
      const result = await createGroupHandler({ name: "Test Fam", member_handles: [] }, fetcher);

      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe("text");
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.slug).toBe("test-fam");
      expect(parsed.room_id).toBe("!abc:matrix-os.com");
    });

    it("accepts empty member_handles", async () => {
      const fetcher = makeFetcher(makeOkResponse({ slug: "solo", room_id: "!r:m" }, 201));
      const result = await createGroupHandler({ name: "Solo", member_handles: [] }, fetcher);
      expect(result.content[0].type).toBe("text");
    });

    it("uses AbortSignal.timeout(10000)", async () => {
      const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
      const fetcher = makeFetcher(makeOkResponse({ slug: "g", room_id: "!r:m" }, 201));
      await createGroupHandler({ name: "G", member_handles: [] }, fetcher);
      expect(timeoutSpy).toHaveBeenCalledWith(10000);
    });

    it("returns generic error text on non-ok HTTP — does not leak gateway error body", async () => {
      const fetcher = makeFetcher(makeErrorResponse(500, { error: "internal matrix error" }));
      const result = await createGroupHandler({ name: "G", member_handles: [] }, fetcher);

      expect(result.content[0].text).not.toContain("internal matrix error");
      expect(result.content[0].text).not.toContain("500");
      expect(result.content[0].text.length).toBeGreaterThan(0);
    });

    it("returns generic error text on fetch throw — does not leak stack trace", async () => {
      const fetcher: GatewayFetcher = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
      const result = await createGroupHandler({ name: "G", member_handles: [] }, fetcher);

      expect(result.content[0].text).not.toContain("ECONNREFUSED");
      expect(result.content[0].text.length).toBeGreaterThan(0);
    });

    it("uses GATEWAY_URL env when set", async () => {
      const orig = process.env.GATEWAY_URL;
      process.env.GATEWAY_URL = "http://localhost:9999";
      try {
        const fetcher = makeFetcher(makeOkResponse({ slug: "g", room_id: "!r:m" }, 201));
        await createGroupHandler({ name: "G", member_handles: [] }, fetcher);
        const [url] = (fetcher as MockFetcher).mock.calls[0] as [string];
        expect(url).toContain("9999");
      } finally {
        if (orig === undefined) delete process.env.GATEWAY_URL;
        else process.env.GATEWAY_URL = orig;
      }
    });

    it("defaults to localhost:4000 when GATEWAY_URL is unset", async () => {
      const orig = process.env.GATEWAY_URL;
      delete process.env.GATEWAY_URL;
      try {
        const fetcher = makeFetcher(makeOkResponse({ slug: "g", room_id: "!r:m" }, 201));
        await createGroupHandler({ name: "G", member_handles: [] }, fetcher);
        const [url] = (fetcher as MockFetcher).mock.calls[0] as [string];
        expect(url).toContain("localhost:4000");
      } finally {
        if (orig !== undefined) process.env.GATEWAY_URL = orig;
      }
    });
  });

  // ---------------------------------------------------------------------------
  // join_group
  // ---------------------------------------------------------------------------
  describe("joinGroupHandler", () => {
    it("calls POST /api/groups/join with room_id in body", async () => {
      const fetcher = makeFetcher(makeOkResponse({ slug: "test-fam", room_id: "!abc:matrix-os.com" }));
      await joinGroupHandler({ room_id: "!abc:matrix-os.com" }, fetcher);

      const [url, init] = (fetcher as MockFetcher).mock.calls[0] as [string, RequestInit];
      expect(url).toMatch(/\/api\/groups\/join$/);
      expect((init as { method: string }).method).toBe("POST");
      const body = JSON.parse((init as { body: string }).body);
      expect(body).toEqual({ room_id: "!abc:matrix-os.com" });
    });

    it("returns IPC content array with slug and room_id on success", async () => {
      const fetcher = makeFetcher(makeOkResponse({ slug: "test-fam", room_id: "!abc:matrix-os.com" }));
      const result = await joinGroupHandler({ room_id: "!abc:matrix-os.com" }, fetcher);

      expect(result.content).toHaveLength(1);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.slug).toBe("test-fam");
      expect(parsed.room_id).toBe("!abc:matrix-os.com");
    });

    it("uses AbortSignal.timeout(10000)", async () => {
      const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
      const fetcher = makeFetcher(makeOkResponse({ slug: "g", room_id: "!r:m" }));
      await joinGroupHandler({ room_id: "!r:m" }, fetcher);
      expect(timeoutSpy).toHaveBeenCalledWith(10000);
    });

    it("returns generic error on non-ok response without leaking details", async () => {
      const fetcher = makeFetcher(makeErrorResponse(403, { errcode: "M_FORBIDDEN" }));
      const result = await joinGroupHandler({ room_id: "!r:m" }, fetcher);

      expect(result.content[0].text).not.toContain("M_FORBIDDEN");
      expect(result.content[0].text).not.toContain("403");
      expect(result.content[0].text.length).toBeGreaterThan(0);
    });

    it("returns generic error on fetch throw", async () => {
      const fetcher: GatewayFetcher = vi.fn().mockRejectedValue(new Error("timeout"));
      const result = await joinGroupHandler({ room_id: "!r:m" }, fetcher);

      expect(result.content[0].text).not.toContain("timeout");
      expect(result.content[0].text.length).toBeGreaterThan(0);
    });
  });

  // ---------------------------------------------------------------------------
  // list_groups
  // ---------------------------------------------------------------------------
  describe("listGroupsHandler", () => {
    const groupList = [
      { slug: "test-fam", name: "Test Fam", room_id: "!abc:matrix-os.com", owner_handle: "@alice:matrix-os.com", joined_at: "2026-04-12T00:00:00Z" },
    ];

    it("calls GET /api/groups with no body", async () => {
      const fetcher = makeFetcher(makeOkResponse({ groups: groupList }));
      await listGroupsHandler(fetcher);

      const [url, init] = (fetcher as MockFetcher).mock.calls[0] as [string, RequestInit];
      expect(url).toMatch(/\/api\/groups$/);
      expect((init as { method: string }).method).toBe("GET");
      expect((init as { body?: unknown }).body).toBeUndefined();
    });

    it("returns IPC content array with groups array on success", async () => {
      const fetcher = makeFetcher(makeOkResponse({ groups: groupList }));
      const result = await listGroupsHandler(fetcher);

      expect(result.content).toHaveLength(1);
      const parsed = JSON.parse(result.content[0].text);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed[0].slug).toBe("test-fam");
      expect(parsed[0].name).toBe("Test Fam");
      expect(parsed[0].owner_handle).toBe("@alice:matrix-os.com");
      expect(parsed[0].joined_at).toBeDefined();
    });

    it("returns empty array when groups is empty", async () => {
      const fetcher = makeFetcher(makeOkResponse({ groups: [] }));
      const result = await listGroupsHandler(fetcher);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed).toEqual([]);
    });

    it("uses AbortSignal.timeout(10000)", async () => {
      const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
      const fetcher = makeFetcher(makeOkResponse({ groups: [] }));
      await listGroupsHandler(fetcher);
      expect(timeoutSpy).toHaveBeenCalledWith(10000);
    });

    it("returns generic error on non-ok response", async () => {
      const fetcher = makeFetcher(makeErrorResponse(500));
      const result = await listGroupsHandler(fetcher);
      expect(result.content[0].text).not.toContain("500");
      expect(result.content[0].text.length).toBeGreaterThan(0);
    });

    it("returns generic error on fetch throw", async () => {
      const fetcher: GatewayFetcher = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
      const result = await listGroupsHandler(fetcher);
      expect(result.content[0].text).not.toContain("ECONNREFUSED");
      expect(result.content[0].text.length).toBeGreaterThan(0);
    });
  });

  // ---------------------------------------------------------------------------
  // leave_group
  // ---------------------------------------------------------------------------
  describe("leaveGroupHandler", () => {
    it("calls POST /api/groups/:slug/leave with slug in URL", async () => {
      const fetcher = makeFetcher(makeOkResponse({ ok: true }));
      await leaveGroupHandler({ slug: "test-fam" }, fetcher);

      const [url, init] = (fetcher as MockFetcher).mock.calls[0] as [string, RequestInit];
      expect(url).toMatch(/\/api\/groups\/test-fam\/leave$/);
      expect((init as { method: string }).method).toBe("POST");
    });

    it("returns IPC content array with ok:true on success", async () => {
      const fetcher = makeFetcher(makeOkResponse({ ok: true }));
      const result = await leaveGroupHandler({ slug: "test-fam" }, fetcher);

      expect(result.content).toHaveLength(1);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.ok).toBe(true);
    });

    it("uses AbortSignal.timeout(10000)", async () => {
      const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
      const fetcher = makeFetcher(makeOkResponse({ ok: true }));
      await leaveGroupHandler({ slug: "test-fam" }, fetcher);
      expect(timeoutSpy).toHaveBeenCalledWith(10000);
    });

    it("returns generic error on non-ok response without leaking details", async () => {
      const fetcher = makeFetcher(makeErrorResponse(404, { error: "group not found" }));
      const result = await leaveGroupHandler({ slug: "nonexistent" }, fetcher);

      expect(result.content[0].text).not.toContain("group not found");
      expect(result.content[0].text).not.toContain("404");
      expect(result.content[0].text.length).toBeGreaterThan(0);
    });

    it("returns generic error on fetch throw", async () => {
      const fetcher: GatewayFetcher = vi.fn().mockRejectedValue(new Error("socket hang up"));
      const result = await leaveGroupHandler({ slug: "test-fam" }, fetcher);
      expect(result.content[0].text).not.toContain("socket hang up");
      expect(result.content[0].text.length).toBeGreaterThan(0);
    });

    it("URL-encodes the slug in the leave path", async () => {
      const fetcher = makeFetcher(makeOkResponse({ ok: true }));
      await leaveGroupHandler({ slug: "my group" }, fetcher);
      const [url] = (fetcher as MockFetcher).mock.calls[0] as [string];
      expect(url).not.toContain("my group");
      expect(url).toContain("my%20group");
    });
  });
});
