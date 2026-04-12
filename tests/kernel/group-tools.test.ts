import { describe, it, expect, vi, beforeEach } from "vitest";
import type { GatewayFetcher, GatewayFetchResponse } from "../../packages/kernel/src/tools/integrations.js";

// Imports will fail until group-tools.ts is created (T022) — that's the Red phase.
import {
  createGroupHandler,
  joinGroupHandler,
  listGroupsHandler,
  leaveGroupHandler,
  setAppAclHandler,
  shareAppHandler,
  groupDataHandler,
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

  // ---------------------------------------------------------------------------
  // set_app_acl
  // ---------------------------------------------------------------------------
  describe("setAppAclHandler", () => {
    it("calls POST /api/groups/:slug/apps/:app/acl with ACL fields", async () => {
      const fetcher = makeFetcher(makeOkResponse({ ok: true }));
      await setAppAclHandler({ group_slug: "test-fam", app_slug: "notes", write_pl: 50 }, fetcher);

      const [url, init] = (fetcher as MockFetcher).mock.calls[0] as [string, RequestInit];
      expect(url).toMatch(/\/api\/groups\/test-fam\/apps\/notes\/acl$/);
      expect((init as { method: string }).method).toBe("POST");
      const body = JSON.parse((init as { body: string }).body);
      expect(body.write_pl).toBe(50);
      expect(body.group_slug).toBeUndefined();
      expect(body.app_slug).toBeUndefined();
    });

    it("returns IPC content on success", async () => {
      const fetcher = makeFetcher(makeOkResponse({ ok: true }));
      const result = await setAppAclHandler({ group_slug: "test-fam", app_slug: "notes" }, fetcher);
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe("text");
    });

    it("uses AbortSignal.timeout(10000)", async () => {
      const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
      const fetcher = makeFetcher(makeOkResponse({ ok: true }));
      await setAppAclHandler({ group_slug: "g", app_slug: "notes" }, fetcher);
      expect(timeoutSpy).toHaveBeenCalledWith(10000);
    });

    it("returns 'Permission denied.' on 403 without leaking details", async () => {
      const fetcher = makeFetcher(makeErrorResponse(403, { error: "caller lacks install_pl" }));
      const result = await setAppAclHandler({ group_slug: "g", app_slug: "notes" }, fetcher);
      expect(result.content[0].text).toBe("Permission denied.");
      expect(result.content[0].text).not.toContain("install_pl");
    });

    it("returns generic error on non-403 non-ok response", async () => {
      const fetcher = makeFetcher(makeErrorResponse(500));
      const result = await setAppAclHandler({ group_slug: "g", app_slug: "notes" }, fetcher);
      expect(result.content[0].text).not.toContain("500");
      expect(result.content[0].text.length).toBeGreaterThan(0);
    });

    it("returns generic error on fetch throw", async () => {
      const fetcher: GatewayFetcher = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
      const result = await setAppAclHandler({ group_slug: "g", app_slug: "notes" }, fetcher);
      expect(result.content[0].text).not.toContain("ECONNREFUSED");
    });

    it("URL-encodes both slug and app_slug", async () => {
      const fetcher = makeFetcher(makeOkResponse({ ok: true }));
      await setAppAclHandler({ group_slug: "my group", app_slug: "my app" }, fetcher);
      const [url] = (fetcher as MockFetcher).mock.calls[0] as [string];
      expect(url).toContain("my%20group");
      expect(url).toContain("my%20app");
    });
  });

  // ---------------------------------------------------------------------------
  // share_app
  // ---------------------------------------------------------------------------
  describe("shareAppHandler", () => {
    it("calls POST /api/groups/:slug/share-app with app_slug in body", async () => {
      const fetcher = makeFetcher(makeOkResponse({ ok: true }));
      await shareAppHandler({ app_slug: "notes", group_slug: "test-fam" }, fetcher);

      const [url, init] = (fetcher as MockFetcher).mock.calls[0] as [string, RequestInit];
      expect(url).toMatch(/\/api\/groups\/test-fam\/share-app$/);
      expect((init as { method: string }).method).toBe("POST");
      const body = JSON.parse((init as { body: string }).body);
      expect(body.app_slug).toBe("notes");
      expect(body.group_slug).toBeUndefined();
    });

    it("returns IPC content on success", async () => {
      const fetcher = makeFetcher(makeOkResponse({ ok: true, app_slug: "notes" }));
      const result = await shareAppHandler({ app_slug: "notes", group_slug: "test-fam" }, fetcher);
      expect(result.content).toHaveLength(1);
    });

    it("uses AbortSignal.timeout(10000)", async () => {
      const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
      const fetcher = makeFetcher(makeOkResponse({ ok: true }));
      await shareAppHandler({ app_slug: "notes", group_slug: "g" }, fetcher);
      expect(timeoutSpy).toHaveBeenCalledWith(10000);
    });

    it("returns 'Permission denied.' on 403 without leaking details", async () => {
      const fetcher = makeFetcher(makeErrorResponse(403, { error: "caller lacks install_pl" }));
      const result = await shareAppHandler({ app_slug: "notes", group_slug: "g" }, fetcher);
      expect(result.content[0].text).toBe("Permission denied.");
      expect(result.content[0].text).not.toContain("install_pl");
    });

    it("returns generic error on non-403 non-ok response", async () => {
      const fetcher = makeFetcher(makeErrorResponse(500));
      const result = await shareAppHandler({ app_slug: "notes", group_slug: "g" }, fetcher);
      expect(result.content[0].text).not.toContain("500");
    });

    it("returns generic error on fetch throw", async () => {
      const fetcher: GatewayFetcher = vi.fn().mockRejectedValue(new Error("timeout"));
      const result = await shareAppHandler({ app_slug: "notes", group_slug: "g" }, fetcher);
      expect(result.content[0].text).not.toContain("timeout");
    });

    it("URL-encodes the group slug", async () => {
      const fetcher = makeFetcher(makeOkResponse({ ok: true }));
      await shareAppHandler({ app_slug: "notes", group_slug: "my group" }, fetcher);
      const [url] = (fetcher as MockFetcher).mock.calls[0] as [string];
      expect(url).toContain("my%20group");
    });
  });

  // ---------------------------------------------------------------------------
  // group_data
  // ---------------------------------------------------------------------------
  describe("groupDataHandler", () => {
    it("calls POST /api/groups/:slug/data with action/app_slug/key in body", async () => {
      const fetcher = makeFetcher(makeOkResponse({ value: "hello" }));
      await groupDataHandler({ action: "read", group_slug: "test-fam", app_slug: "notes", key: "note1" }, fetcher);

      const [url, init] = (fetcher as MockFetcher).mock.calls[0] as [string, RequestInit];
      expect(url).toMatch(/\/api\/groups\/test-fam\/data$/);
      expect((init as { method: string }).method).toBe("POST");
      const body = JSON.parse((init as { body: string }).body);
      expect(body.action).toBe("read");
      expect(body.app_slug).toBe("notes");
      expect(body.key).toBe("note1");
      expect(body.group_slug).toBeUndefined();
    });

    it("passes value in body for write action", async () => {
      const fetcher = makeFetcher(makeOkResponse({ ok: true }));
      await groupDataHandler({ action: "write", group_slug: "test-fam", app_slug: "notes", key: "note1", value: "hello" }, fetcher);
      const [, init] = (fetcher as MockFetcher).mock.calls[0] as [string, RequestInit];
      const body = JSON.parse((init as { body: string }).body);
      expect(body.value).toBe("hello");
    });

    it("returns IPC content on success", async () => {
      const fetcher = makeFetcher(makeOkResponse({ value: "hello" }));
      const result = await groupDataHandler({ action: "read", group_slug: "test-fam", app_slug: "notes" }, fetcher);
      expect(result.content).toHaveLength(1);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.value).toBe("hello");
    });

    it("uses AbortSignal.timeout(10000)", async () => {
      const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
      const fetcher = makeFetcher(makeOkResponse({ ok: true }));
      await groupDataHandler({ action: "list", group_slug: "g", app_slug: "notes" }, fetcher);
      expect(timeoutSpy).toHaveBeenCalledWith(10000);
    });

    it("returns 'Invalid request.' on 400 without leaking Zod error", async () => {
      const fetcher = makeFetcher(makeErrorResponse(400, { error: "value is required for write action" }));
      const result = await groupDataHandler({ action: "write", group_slug: "g", app_slug: "notes" }, fetcher);
      expect(result.content[0].text).toBe("Invalid request.");
      expect(result.content[0].text).not.toContain("required for write");
    });

    it("returns 'Payload too large.' on 413 without leaking details", async () => {
      const fetcher = makeFetcher(makeErrorResponse(413, { error: "body too large" }));
      const result = await groupDataHandler({ action: "write", group_slug: "g", app_slug: "notes", key: "k", value: "x" }, fetcher);
      expect(result.content[0].text).toBe("Payload too large.");
      expect(result.content[0].text).not.toContain("body too large");
    });

    it("returns 'Permission denied.' on 403", async () => {
      const fetcher = makeFetcher(makeErrorResponse(403, { error: "write_pl not met" }));
      const result = await groupDataHandler({ action: "write", group_slug: "g", app_slug: "notes", key: "k", value: "v" }, fetcher);
      expect(result.content[0].text).toBe("Permission denied.");
      expect(result.content[0].text).not.toContain("write_pl");
    });

    it("returns generic error on other non-ok response", async () => {
      const fetcher = makeFetcher(makeErrorResponse(500));
      const result = await groupDataHandler({ action: "read", group_slug: "g", app_slug: "notes" }, fetcher);
      expect(result.content[0].text).not.toContain("500");
    });

    it("returns generic error on fetch throw", async () => {
      const fetcher: GatewayFetcher = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
      const result = await groupDataHandler({ action: "list", group_slug: "g", app_slug: "notes" }, fetcher);
      expect(result.content[0].text).not.toContain("ECONNREFUSED");
    });

    it("URL-encodes the group slug", async () => {
      const fetcher = makeFetcher(makeOkResponse({ keys: [] }));
      await groupDataHandler({ action: "list", group_slug: "my group", app_slug: "notes" }, fetcher);
      const [url] = (fetcher as MockFetcher).mock.calls[0] as [string];
      expect(url).toContain("my%20group");
    });
  });
});
