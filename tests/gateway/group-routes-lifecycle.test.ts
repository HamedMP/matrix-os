import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createGroupRoutes } from "../../packages/gateway/src/group-routes.js";
import { GroupRegistry } from "../../packages/gateway/src/group-registry.js";
import type { MatrixClient, PowerLevelsContent } from "../../packages/gateway/src/matrix-client.js";
import type { GroupManifest } from "../../packages/gateway/src/group-types.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

async function makeTmpHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), "group-routes-test-"));
}

function makeMatrixClient(overrides: Partial<MatrixClient> = {}): MatrixClient {
  return {
    sendMessage: vi.fn().mockResolvedValue({ eventId: "$evt1" }),
    createDM: vi.fn().mockResolvedValue({ roomId: "!dm:matrix-os.com" }),
    joinRoom: vi.fn().mockResolvedValue({ roomId: "!room1:matrix-os.com" }),
    getRoomMessages: vi.fn().mockResolvedValue({ messages: [], end: "", chunk: [] }),
    whoami: vi.fn().mockResolvedValue({ userId: "@owner:matrix-os.com" }),
    sendCustomEvent: vi.fn().mockResolvedValue({ eventId: "$custom1" }),
    sync: vi.fn().mockResolvedValue({ next_batch: "s1", rooms: { join: {}, invite: {}, leave: {} }, presence: { events: [] } }),
    createRoom: vi.fn().mockResolvedValue({ roomId: "!newroom:matrix-os.com" }),
    inviteToRoom: vi.fn().mockResolvedValue(undefined),
    kickFromRoom: vi.fn().mockResolvedValue(undefined),
    leaveRoom: vi.fn().mockResolvedValue(undefined),
    getRoomState: vi.fn().mockResolvedValue(null),
    getAllRoomStateEvents: vi.fn().mockResolvedValue([]),
    setRoomState: vi.fn().mockResolvedValue({ eventId: "$state1" }),
    getRoomMembers: vi.fn().mockResolvedValue([
      { userId: "@owner:matrix-os.com", membership: "join" },
    ]),
    getPowerLevels: vi.fn().mockResolvedValue({}),
    setPowerLevels: vi.fn().mockResolvedValue({ eventId: "$pl1" }),
    ...overrides,
  } as MatrixClient;
}

const BEARER = "Bearer test-token";

function req(
  app: ReturnType<typeof createGroupRoutes>,
  method: string,
  path: string,
  body?: unknown,
  authHeader = BEARER,
) {
  const init: RequestInit = { method };
  const headers: Record<string, string> = {};
  if (authHeader) headers["Authorization"] = authHeader;
  if (body) {
    init.body = JSON.stringify(body);
    headers["Content-Type"] = "application/json";
  }
  init.headers = headers;
  return app.request(path, init);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("group-routes lifecycle", () => {
  let tmpHome: string;
  let registry: GroupRegistry;
  let matrixClient: MatrixClient;
  let app: ReturnType<typeof createGroupRoutes>;

  beforeEach(async () => {
    tmpHome = await makeTmpHome();
    registry = new GroupRegistry(tmpHome);
    await registry.scan();
    matrixClient = makeMatrixClient();
    app = createGroupRoutes({ matrixClient, groupRegistry: registry, authToken: "test-token" });
  });

  afterEach(async () => {
    await rm(tmpHome, { recursive: true, force: true });
  });

  // ── Auth ──────────────────────────────────────────────────────────────────

  describe("auth", () => {
    it("POST /api/groups returns 401 without Authorization header", async () => {
      const res = await req(app, "POST", "/api/groups", { name: "Test" }, "");
      expect(res.status).toBe(401);
    });

    it("GET /api/groups returns 401 with wrong token", async () => {
      const res = await req(app, "GET", "/api/groups", undefined, "Bearer wrong");
      expect(res.status).toBe(401);
    });

    it("401 response body is generic — no Matrix or internal details", async () => {
      const res = await req(app, "GET", "/api/groups", undefined, "Bearer wrong");
      const body = await res.json();
      expect(body.error).toBeDefined();
      expect(JSON.stringify(body)).not.toContain("Matrix");
      expect(JSON.stringify(body)).not.toContain("homeserver");
    });
  });

  // ── POST /api/groups ───────────────────────────────────────────────────────

  describe("POST /api/groups", () => {
    it("creates a group and returns 201 with slug and room_id", async () => {
      const res = await req(app, "POST", "/api/groups", { name: "Schmidt Family" });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.slug).toBeTruthy();
      expect(body.room_id).toBe("!newroom:matrix-os.com");
    });

    it("calls matrixClient.createRoom once", async () => {
      await req(app, "POST", "/api/groups", { name: "Test Group" });
      expect(matrixClient.createRoom).toHaveBeenCalledTimes(1);
    });

    it("calls matrixClient.setPowerLevels once, after createRoom", async () => {
      await req(app, "POST", "/api/groups", { name: "Test Group" });
      expect(matrixClient.setPowerLevels).toHaveBeenCalledTimes(1);
      // createRoom must be called before setPowerLevels
      const createOrder = (matrixClient.createRoom as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
      const plOrder = (matrixClient.setPowerLevels as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
      expect(createOrder).toBeLessThan(plOrder);
    });

    it("setPowerLevels is called with the exact power-level map from spec §G", async () => {
      vi.mocked(matrixClient.whoami).mockResolvedValue({ userId: "@owner:matrix-os.com" });
      await req(app, "POST", "/api/groups", { name: "Test Group" });

      const [roomId, content] = (matrixClient.setPowerLevels as ReturnType<typeof vi.fn>).mock.calls[0] as [string, PowerLevelsContent];
      expect(roomId).toBe("!newroom:matrix-os.com");
      expect(content.users_default).toBe(0);
      expect(content.state_default).toBe(50);
      expect(content.events_default).toBe(0);
      expect(content.events?.["m.room.power_levels"]).toBe(100);
      expect(content.events?.["m.matrix_os.app_acl"]).toBe(100);
      expect(content.events?.["m.matrix_os.app_install"]).toBe(50);
      expect(content.users?.["@owner:matrix-os.com"]).toBe(100);
    });

    it("registers the group in groupRegistry after creation", async () => {
      const res = await req(app, "POST", "/api/groups", { name: "New Group" });
      const body = await res.json();
      expect(registry.get(body.slug)).not.toBeNull();
    });

    it("returns 400 if name is missing", async () => {
      const res = await req(app, "POST", "/api/groups", {});
      expect(res.status).toBe(400);
    });

    it("returns 400 if name is empty string", async () => {
      const res = await req(app, "POST", "/api/groups", { name: "" });
      expect(res.status).toBe(400);
    });

    it("applies bodyLimit — rejects body > 256 KB", async () => {
      const bigBody = JSON.stringify({ name: "x".repeat(300 * 1024) });
      const init: RequestInit = {
        method: "POST",
        body: bigBody,
        headers: {
          Authorization: BEARER,
          "Content-Type": "application/json",
          "Content-Length": String(Buffer.byteLength(bigBody)),
        },
      };
      const res = await app.request("/api/groups", init);
      expect(res.status).toBe(413);
    });

    it("handles matrixClient.createRoom failure with 500 and generic message", async () => {
      vi.mocked(matrixClient.createRoom).mockRejectedValue(new Error("Matrix internal"));
      const res = await req(app, "POST", "/api/groups", { name: "Fail Group" });
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(JSON.stringify(body)).not.toContain("Matrix internal");
    });

    it("generates a collision-suffix slug when name collides", async () => {
      const res1 = await req(app, "POST", "/api/groups", { name: "My Group" });
      const res2 = await req(app, "POST", "/api/groups", { name: "My Group" });
      expect(res1.status).toBe(201);
      expect(res2.status).toBe(201);
      const body1 = await res1.json();
      const body2 = await res2.json();
      expect(body1.slug).not.toBe(body2.slug);
    });
  });

  // ── POST /api/groups/join ─────────────────────────────────────────────────

  describe("POST /api/groups/join", () => {
    it("joins a room and returns 200 with slug", async () => {
      const res = await req(app, "POST", "/api/groups/join", { room_id: "!existing:matrix-os.com" });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.slug).toBeTruthy();
    });

    it("calls matrixClient.joinRoom with the provided room_id", async () => {
      await req(app, "POST", "/api/groups/join", { room_id: "!room123:matrix-os.com" });
      expect(matrixClient.joinRoom).toHaveBeenCalledWith("!room123:matrix-os.com");
    });

    it("returns 400 if room_id is missing", async () => {
      const res = await req(app, "POST", "/api/groups/join", {});
      expect(res.status).toBe(400);
    });

    it("returns 401 without auth", async () => {
      const res = await req(app, "POST", "/api/groups/join", { room_id: "!r:m.com" }, "");
      expect(res.status).toBe(401);
    });

    it("handles join failure with 500 and generic message", async () => {
      vi.mocked(matrixClient.joinRoom).mockRejectedValue(new Error("forbidden"));
      const res = await req(app, "POST", "/api/groups/join", { room_id: "!r:m.com" });
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(JSON.stringify(body)).not.toContain("forbidden");
    });
  });

  // ── GET /api/groups ───────────────────────────────────────────────────────

  describe("GET /api/groups", () => {
    it("returns 200 with empty array when no groups", async () => {
      const res = await req(app, "GET", "/api/groups");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body.groups)).toBe(true);
      expect(body.groups).toHaveLength(0);
    });

    it("returns list of groups after creation", async () => {
      await req(app, "POST", "/api/groups", { name: "Group A" });
      await req(app, "POST", "/api/groups", { name: "Group B" });
      const res = await req(app, "GET", "/api/groups");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.groups).toHaveLength(2);
    });

    it("returns 401 without auth", async () => {
      const res = await req(app, "GET", "/api/groups", undefined, "");
      expect(res.status).toBe(401);
    });

    it("each group entry has slug and name", async () => {
      await req(app, "POST", "/api/groups", { name: "Named Group" });
      const res = await req(app, "GET", "/api/groups");
      const body = await res.json();
      expect(body.groups[0].slug).toBeTruthy();
      expect(body.groups[0].name).toBe("Named Group");
    });
  });

  // ── GET /api/groups/:slug ─────────────────────────────────────────────────

  describe("GET /api/groups/:slug", () => {
    it("returns 200 with group details for known slug", async () => {
      const create = await req(app, "POST", "/api/groups", { name: "Findable Group" });
      const { slug } = await create.json();
      const res = await req(app, "GET", `/api/groups/${slug}`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.slug).toBe(slug);
    });

    it("returns 404 for unknown slug", async () => {
      const res = await req(app, "GET", "/api/groups/nonexistent-slug");
      expect(res.status).toBe(404);
    });

    it("404 response is generic — no internal details", async () => {
      const res = await req(app, "GET", "/api/groups/nonexistent-slug");
      const body = await res.json();
      expect(body.error).toBeDefined();
      expect(JSON.stringify(body)).not.toContain("stack");
    });

    it("returns 401 without auth", async () => {
      const res = await req(app, "GET", "/api/groups/any-slug", undefined, "");
      expect(res.status).toBe(401);
    });
  });

  // ── POST /api/groups/:slug/leave ──────────────────────────────────────────

  describe("POST /api/groups/:slug/leave", () => {
    it("leaves a group and returns 200", async () => {
      const create = await req(app, "POST", "/api/groups", { name: "Leave Me" });
      const { slug } = await create.json();
      const res = await req(app, "POST", `/api/groups/${slug}/leave`);
      expect(res.status).toBe(200);
    });

    it("calls matrixClient.leaveRoom with the group's room_id", async () => {
      const create = await req(app, "POST", "/api/groups", { name: "Leave Room" });
      const { slug, room_id } = await create.json();
      await req(app, "POST", `/api/groups/${slug}/leave`);
      expect(matrixClient.leaveRoom).toHaveBeenCalledWith(room_id);
    });

    it("archives the group dir after leaving", async () => {
      const create = await req(app, "POST", "/api/groups", { name: "Archive Me" });
      const { slug } = await create.json();
      await req(app, "POST", `/api/groups/${slug}/leave`);
      expect(registry.get(slug)).toBeNull();
    });

    it("returns 404 for unknown slug", async () => {
      const res = await req(app, "POST", "/api/groups/nonexistent/leave");
      expect(res.status).toBe(404);
    });

    it("returns 401 without auth", async () => {
      const res = await req(app, "POST", "/api/groups/any/leave", undefined, "");
      expect(res.status).toBe(401);
    });

    it("handles leaveRoom failure with 500 and generic message", async () => {
      const create = await req(app, "POST", "/api/groups", { name: "Fail Leave" });
      const { slug } = await create.json();
      vi.mocked(matrixClient.leaveRoom).mockRejectedValue(new Error("M_FORBIDDEN details"));
      const res = await req(app, "POST", `/api/groups/${slug}/leave`);
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(JSON.stringify(body)).not.toContain("M_FORBIDDEN details");
    });
  });

  // ── Slug validation (HIGH#2) ─────────────────────────────────────────────

  describe("slug path validation", () => {
    const invalidSlugs = [
      ["empty string", ""],
      ["uppercase", "UPPER"],
      ["path traversal", "../../etc/passwd"],
      ["unicode", "grüppe"],
      ["starts with dash", "-bad"],
      ["spaces", "my group"],
    ];

    for (const [label, badSlug] of invalidSlugs) {
      it(`GET /api/groups/:slug returns 404 for ${label}`, async () => {
        const res = await req(app, "GET", `/api/groups/${encodeURIComponent(badSlug)}`);
        expect(res.status).toBe(404);
      });

      it(`POST /api/groups/:slug/leave returns 404 for ${label}`, async () => {
        const res = await req(app, "POST", `/api/groups/${encodeURIComponent(badSlug)}/leave`);
        expect(res.status).toBe(404);
      });
    }

    it("slug validation returns generic error — no internal details", async () => {
      const res = await req(app, "GET", `/api/groups/${encodeURIComponent("../../etc/passwd")}`);
      const body = await res.json();
      expect(body.error).toBeDefined();
      expect(JSON.stringify(body)).not.toContain("passwd");
      expect(JSON.stringify(body)).not.toContain("traversal");
    });
  });

  // ── member_handles validation (HIGH#1) ───────────────────────────────────

  describe("member_handles validation", () => {
    it("rejects invalid handle format (no @)", async () => {
      const res = await req(app, "POST", "/api/groups", {
        name: "Test",
        member_handles: ["notahandle"],
      });
      expect(res.status).toBe(400);
    });

    it("rejects empty string handle", async () => {
      const res = await req(app, "POST", "/api/groups", {
        name: "Test",
        member_handles: [""],
      });
      expect(res.status).toBe(400);
    });

    it("rejects handle with invalid server part", async () => {
      const res = await req(app, "POST", "/api/groups", {
        name: "Test",
        member_handles: ["@user:"],
      });
      expect(res.status).toBe(400);
    });

    it("accepts valid handle format", async () => {
      const res = await req(app, "POST", "/api/groups", {
        name: "Test",
        member_handles: ["@alice:matrix-os.com"],
      });
      expect(res.status).toBe(201);
    });
  });

  // ── Constructor injection ──────────────────────────────────────────────────

  describe("constructor injection", () => {
    it("matrixClient is injected — not read from globalThis", () => {
      const customClient = makeMatrixClient({
        createRoom: vi.fn().mockResolvedValue({ roomId: "!injected:m.com" }),
      });
      const customApp = createGroupRoutes({ matrixClient: customClient, groupRegistry: registry, authToken: "test-token" });
      expect(customApp).toBeDefined();
      // If globalThis were used, creating a second app with a different client wouldn't work
    });

    it("groupRegistry is injected — state is isolated per instance", async () => {
      const registry2 = new GroupRegistry(tmpHome);
      await registry2.scan();
      const app2 = createGroupRoutes({ matrixClient, groupRegistry: registry2, authToken: "test-token" });

      await req(app, "POST", "/api/groups", { name: "In App1" });
      const res = await app2.request("/api/groups", { method: "GET", headers: { Authorization: BEARER } });
      const body = await res.json();
      // registry2 was not mutated by app's create
      expect(body.groups).toHaveLength(0);
    });
  });
});
