import { describe, it, expect, vi, beforeEach } from "vitest";
import type { GatewayFetcher, GatewayFetchResponse } from "../../packages/kernel/src/tools/integrations.js";

// These imports will fail until group-tools.ts is created (T022) — that's the point.
import {
  createGroupHandler,
  joinGroupHandler,
  listGroupsHandler,
  leaveGroupHandler,
} from "../../packages/kernel/src/group-tools.js";

function makeOkResponse(body: unknown): GatewayFetchResponse {
  return {
    ok: true,
    status: 200,
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

describe("group lifecycle IPC tools", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // ---------------------------------------------------------------------------
  // create_group
  // ---------------------------------------------------------------------------
  describe("createGroupHandler", () => {
    it("calls POST /api/groups with name and member_handles", async () => {
      const fetcher = makeFetcher(
        makeOkResponse({ slug: "test-fam", room_id: "!abc:matrix-os.com", membership: "admin" }),
      );
      const result = await createGroupHandler(
        { name: "Test Fam", member_handles: ["@bob:matrix-os.com"] },
        fetcher,
      );

      expect(fetcher).toHaveBeenCalledOnce();
      const [url, init] = (fetcher as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
      expect(url).toMatch(/\/api\/groups$/);
      expect((init as { method: string }).method).toBe("POST");
      const body = JSON.parse((init as { body: string }).body);
      expect(body).toEqual({ name: "Test Fam", member_handles: ["@bob:matrix-os.com"] });
    });

    it("returns IPC content array with slug and room_id on success", async () => {
      const fetcher = makeFetcher(
        makeOkResponse({ slug: "test-fam", room_id: "!abc:matrix-os.com", membership: "admin" }),
      );
      const result = await createGroupHandler(
        { name: "Test Fam", member_handles: [] },
        fetcher,
      );

      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe("text");
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.slug).toBe("test-fam");
      expect(parsed.room_id).toBe("!abc:matrix-os.com");
    });

    it("uses AbortSignal.timeout(10000)", async () => {
      const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
      const fetcher = makeFetcher(
        makeOkResponse({ slug: "g", room_id: "!r:m", membership: "admin" }),
      );
      await createGroupHandler({ name: "G", member_handles: [] }, fetcher);
      expect(timeoutSpy).toHaveBeenCalledWith(10000);
    });

    it("returns generic error text on non-ok HTTP response — does not leak gateway error", async () => {
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
        const fetcher = makeFetcher(
          makeOkResponse({ slug: "g", room_id: "!r:m", membership: "admin" }),
        );
        await createGroupHandler({ name: "G", member_handles: [] }, fetcher);
        const [url] = (fetcher as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
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
        const fetcher = makeFetcher(
          makeOkResponse({ slug: "g", room_id: "!r:m", membership: "admin" }),
        );
        await createGroupHandler({ name: "G", member_handles: [] }, fetcher);
        const [url] = (fetcher as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
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
    const manifest = {
      slug: "test-fam",
      name: "Test Fam",
      room_id: "!abc:matrix-os.com",
      member_count: 2,
      last_activity: "2026-04-12T00:00:00Z",
    };

    it("calls POST /api/groups/join with room_id in body", async () => {
      const fetcher = makeFetcher(makeOkResponse({ slug: "test-fam", manifest }));
      await joinGroupHandler({ room_id: "!abc:matrix-os.com" }, fetcher);

      const [url, init] = (fetcher as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
      expect(url).toMatch(/\/api\/groups\/join$/);
      expect((init as { method: string }).method).toBe("POST");
      const body = JSON.parse((init as { body: string }).body);
      expect(body).toEqual({ room_id: "!abc:matrix-os.com" });
    });

    it("returns IPC content array with slug and manifest on success", async () => {
      const fetcher = makeFetcher(makeOkResponse({ slug: "test-fam", manifest }));
      const result = await joinGroupHandler({ room_id: "!abc:matrix-os.com" }, fetcher);

      expect(result.content).toHaveLength(1);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.slug).toBe("test-fam");
      expect(parsed.manifest).toBeDefined();
    });

    it("uses AbortSignal.timeout(10000)", async () => {
      const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
      const fetcher = makeFetcher(makeOkResponse({ slug: "g", manifest }));
      await joinGroupHandler({ room_id: "!r:m" }, fetcher);
      expect(timeoutSpy).toHaveBeenCalledWith(10000);
    });

    it("returns generic error on non-ok response without leaking details", async () => {
      const fetcher = makeFetcher(makeErrorResponse(403, { errcode: "M_FORBIDDEN" }));
      const result = await joinGroupHandler({ room_id: "!r:m" }, fetcher);

      expect(result.content[0].text).not.toContain("M_FORBIDDEN");
      expect(result.content[0].text).not.toContain("403");
    });

    it("returns generic error on fetch throw", async () => {
      const fetcher: GatewayFetcher = vi.fn().mockRejectedValue(new Error("timeout"));
      const result = await joinGroupHandler({ room_id: "!r:m" }, fetcher);

      expect(result.content[0].text).not.toContain("timeout");
    });
  });

  // ---------------------------------------------------------------------------
  // list_groups
  // ---------------------------------------------------------------------------
  describe("listGroupsHandler", () => {
    const groups = [
      { slug: "test-fam", name: "Test Fam", member_count: 2, last_activity: "2026-04-12T00:00:00Z" },
    ];

    it("calls GET /api/groups with no body", async () => {
      const fetcher = makeFetcher(makeOkResponse(groups));
      await listGroupsHandler(fetcher);

      const [url, init] = (fetcher as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
      expect(url).toMatch(/\/api\/groups$/);
      expect((init as { method: string }).method).toBe("GET");
      expect((init as { body?: unknown }).body).toBeUndefined();
    });

    it("returns IPC content array with group list on success", async () => {
      const fetcher = makeFetcher(makeOkResponse(groups));
      const result = await listGroupsHandler(fetcher);

      expect(result.content).toHaveLength(1);
      const parsed = JSON.parse(result.content[0].text);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed[0].slug).toBe("test-fam");
      expect(parsed[0].name).toBe("Test Fam");
      expect(parsed[0].member_count).toBe(2);
      expect(parsed[0].last_activity).toBeDefined();
    });

    it("uses AbortSignal.timeout(10000)", async () => {
      const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
      const fetcher = makeFetcher(makeOkResponse([]));
      await listGroupsHandler(fetcher);
      expect(timeoutSpy).toHaveBeenCalledWith(10000);
    });

    it("returns generic error on non-ok response", async () => {
      const fetcher = makeFetcher(makeErrorResponse(500));
      const result = await listGroupsHandler(fetcher);
      expect(result.content[0].text).not.toContain("500");
    });

    it("returns generic error on fetch throw", async () => {
      const fetcher: GatewayFetcher = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
      const result = await listGroupsHandler(fetcher);
      expect(result.content[0].text).not.toContain("ECONNREFUSED");
    });
  });

  // ---------------------------------------------------------------------------
  // leave_group
  // ---------------------------------------------------------------------------
  describe("leaveGroupHandler", () => {
    it("calls POST /api/groups/:slug/leave with slug in URL", async () => {
      const fetcher = makeFetcher(makeOkResponse({ archived_path: "~/groups/_archive/test-fam-1234" }));
      await leaveGroupHandler({ slug: "test-fam" }, fetcher);

      const [url, init] = (fetcher as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
      expect(url).toMatch(/\/api\/groups\/test-fam\/leave$/);
      expect((init as { method: string }).method).toBe("POST");
    });

    it("returns IPC content array with archived_path on success", async () => {
      const fetcher = makeFetcher(makeOkResponse({ archived_path: "~/groups/_archive/test-fam-1234" }));
      const result = await leaveGroupHandler({ slug: "test-fam" }, fetcher);

      expect(result.content).toHaveLength(1);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.archived_path).toContain("test-fam");
    });

    it("returns IPC content array even when archived_path is absent", async () => {
      const fetcher = makeFetcher(makeOkResponse({}));
      const result = await leaveGroupHandler({ slug: "test-fam" }, fetcher);
      expect(result.content).toHaveLength(1);
    });

    it("uses AbortSignal.timeout(10000)", async () => {
      const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
      const fetcher = makeFetcher(makeOkResponse({}));
      await leaveGroupHandler({ slug: "test-fam" }, fetcher);
      expect(timeoutSpy).toHaveBeenCalledWith(10000);
    });

    it("returns generic error on non-ok response without leaking details", async () => {
      const fetcher = makeFetcher(makeErrorResponse(404, { error: "group not found" }));
      const result = await leaveGroupHandler({ slug: "nonexistent" }, fetcher);

      expect(result.content[0].text).not.toContain("group not found");
      expect(result.content[0].text).not.toContain("404");
    });

    it("returns generic error on fetch throw", async () => {
      const fetcher: GatewayFetcher = vi.fn().mockRejectedValue(new Error("socket hang up"));
      const result = await leaveGroupHandler({ slug: "test-fam" }, fetcher);
      expect(result.content[0].text).not.toContain("socket hang up");
    });

    it("URL-encodes the slug in the leave path", async () => {
      const fetcher = makeFetcher(makeOkResponse({}));
      await leaveGroupHandler({ slug: "my group" }, fetcher);
      const [url] = (fetcher as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
      expect(url).not.toContain("my group");
      expect(url).toContain("my%20group");
    });
  });
});
