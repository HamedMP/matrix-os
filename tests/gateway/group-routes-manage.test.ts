import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createGroupRoutes } from "../../packages/gateway/src/group-routes.js";
import { GroupRegistry } from "../../packages/gateway/src/group-registry.js";
import type { MatrixClient } from "../../packages/gateway/src/matrix-client.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

async function makeTmpHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), "group-manage-test-"));
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
    getPowerLevels: vi.fn().mockResolvedValue({
      users: { "@owner:matrix-os.com": 100 },
      users_default: 0,
      kick: 50,
      state_default: 50,
    }),
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

async function createTestGroup(
  app: ReturnType<typeof createGroupRoutes>,
  name = "Test Group",
): Promise<{ slug: string; room_id: string }> {
  const res = await req(app, "POST", "/api/groups", { name });
  return res.json();
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("group-routes manage", () => {
  let tmpHome: string;
  let registry: GroupRegistry;
  let matrixClient: MatrixClient;
  let app: ReturnType<typeof createGroupRoutes>;

  beforeEach(async () => {
    tmpHome = await makeTmpHome();
    registry = new GroupRegistry(tmpHome);
    await registry.scan();
    matrixClient = makeMatrixClient();
    app = createGroupRoutes({ matrixClient, groupRegistry: registry, authToken: "test-token", homePath: tmpHome });
  });

  afterEach(async () => {
    await rm(tmpHome, { recursive: true, force: true });
  });

  // ── PATCH /api/groups/:slug (rename) ─────────────────────────────────────

  describe("PATCH /api/groups/:slug", () => {
    it("renames a group and returns 200", async () => {
      const { slug } = await createTestGroup(app);
      const res = await req(app, "PATCH", `/api/groups/${slug}`, { name: "New Name" });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.name).toBe("New Name");
    });

    it("updates m.room.name state event on Matrix", async () => {
      const { slug } = await createTestGroup(app);
      await req(app, "PATCH", `/api/groups/${slug}`, { name: "New Name" });
      expect(matrixClient.setRoomState).toHaveBeenCalledWith(
        expect.any(String),
        "m.room.name",
        "",
        { name: "New Name" },
      );
    });

    it("updates local manifest via registry", async () => {
      const { slug } = await createTestGroup(app);
      await req(app, "PATCH", `/api/groups/${slug}`, { name: "Updated Name" });
      const manifest = registry.get(slug);
      expect(manifest?.name).toBe("Updated Name");
    });

    it("returns 403 when caller PL < state_default (50)", async () => {
      vi.mocked(matrixClient.getPowerLevels).mockResolvedValue({
        users: { "@owner:matrix-os.com": 10 },
        users_default: 0,
        state_default: 50,
      });
      const { slug } = await createTestGroup(app);
      const res = await req(app, "PATCH", `/api/groups/${slug}`, { name: "No Permission" });
      expect(res.status).toBe(403);
    });

    it("returns 400 for empty name", async () => {
      const { slug } = await createTestGroup(app);
      const res = await req(app, "PATCH", `/api/groups/${slug}`, { name: "" });
      expect(res.status).toBe(400);
    });

    it("returns 400 for missing name", async () => {
      const { slug } = await createTestGroup(app);
      const res = await req(app, "PATCH", `/api/groups/${slug}`, {});
      expect(res.status).toBe(400);
    });

    it("returns 404 for unknown slug", async () => {
      const res = await req(app, "PATCH", "/api/groups/nonexistent", { name: "X" });
      expect(res.status).toBe(404);
    });

    it("returns 401 without auth", async () => {
      const res = await req(app, "PATCH", "/api/groups/any", { name: "X" }, "");
      expect(res.status).toBe(401);
    });

    it("does not leak internal errors on Matrix failure", async () => {
      vi.mocked(matrixClient.setRoomState).mockRejectedValue(new Error("M_FORBIDDEN internal"));
      const { slug } = await createTestGroup(app);
      // Reset the mock after group creation used setRoomState
      vi.mocked(matrixClient.setRoomState).mockRejectedValue(new Error("M_FORBIDDEN internal"));
      const res = await req(app, "PATCH", `/api/groups/${slug}`, { name: "Fail" });
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(JSON.stringify(body)).not.toContain("M_FORBIDDEN");
    });
  });

  // ── DELETE /api/groups/:slug/apps/:app (unshare) ─────────────────────────

  describe("DELETE /api/groups/:slug/apps/:app", () => {
    async function shareApp(slug: string, appSlug: string) {
      const srcDir = join(tmpHome, "apps", appSlug);
      await mkdir(srcDir, { recursive: true });
      await writeFile(join(srcDir, "index.html"), "<h1>App</h1>");
      await writeFile(join(srcDir, "meta.json"), JSON.stringify({ name: appSlug }));
      await req(app, "POST", `/api/groups/${slug}/share-app`, { app_slug: appSlug });
    }

    it("unshares an app and returns 200", async () => {
      const { slug } = await createTestGroup(app);
      await shareApp(slug, "notes");
      const res = await req(app, "DELETE", `/api/groups/${slug}/apps/notes`);
      expect(res.status).toBe(200);
    });

    it("removes the app directory", async () => {
      const { slug } = await createTestGroup(app);
      await shareApp(slug, "notes");
      await req(app, "DELETE", `/api/groups/${slug}/apps/notes`);
      const listRes = await req(app, "GET", `/api/groups/${slug}/apps`);
      const body = await listRes.json();
      expect(body.apps).toHaveLength(0);
    });

    it("returns 403 when caller PL < 100", async () => {
      vi.mocked(matrixClient.getPowerLevels).mockResolvedValue({
        users: { "@owner:matrix-os.com": 50 },
        users_default: 0,
      });
      const { slug } = await createTestGroup(app);
      const res = await req(app, "DELETE", `/api/groups/${slug}/apps/notes`);
      expect(res.status).toBe(403);
    });

    it("returns 404 for unknown group slug", async () => {
      const res = await req(app, "DELETE", "/api/groups/nonexistent/apps/notes");
      expect(res.status).toBe(404);
    });

    it("returns 404 for non-existent app", async () => {
      const { slug } = await createTestGroup(app);
      const res = await req(app, "DELETE", `/api/groups/${slug}/apps/nope`);
      expect(res.status).toBe(404);
    });

    it("returns 401 without auth", async () => {
      const res = await req(app, "DELETE", "/api/groups/any/apps/any", undefined, "");
      expect(res.status).toBe(401);
    });
  });

  // ── PATCH /api/groups/:slug/members/:handle/role ─────────────────────────

  describe("PATCH /api/groups/:slug/members/:handle/role", () => {
    it("changes role and returns 200", async () => {
      const { slug } = await createTestGroup(app);
      const handle = encodeURIComponent("@bob:matrix-os.com");
      const res = await req(app, "PATCH", `/api/groups/${slug}/members/${handle}/role`, { role: "editor" });
      expect(res.status).toBe(200);
    });

    it("calls setPowerLevels with correct PL mapping", async () => {
      const { slug } = await createTestGroup(app);
      const handle = encodeURIComponent("@bob:matrix-os.com");
      await req(app, "PATCH", `/api/groups/${slug}/members/${handle}/role`, { role: "editor" });
      expect(matrixClient.setPowerLevels).toHaveBeenCalledTimes(1);
      const call = vi.mocked(matrixClient.setPowerLevels).mock.calls[0];
      expect(call[1].users?.["@bob:matrix-os.com"]).toBe(50);
    });

    it("maps owner=100, editor=50, viewer=0", async () => {
      const { slug } = await createTestGroup(app);
      const cases = [
        { role: "owner", pl: 100 },
        { role: "editor", pl: 50 },
        { role: "viewer", pl: 0 },
      ];
      for (const { role, pl } of cases) {
        vi.mocked(matrixClient.setPowerLevels).mockClear();
        const handle = encodeURIComponent("@bob:matrix-os.com");
        await req(app, "PATCH", `/api/groups/${slug}/members/${handle}/role`, { role });
        const call = vi.mocked(matrixClient.setPowerLevels).mock.calls[0];
        expect(call[1].users?.["@bob:matrix-os.com"]).toBe(pl);
      }
    });

    it("returns 403 when caller PL < target PL (can't elevate above self)", async () => {
      vi.mocked(matrixClient.getPowerLevels).mockResolvedValue({
        users: { "@owner:matrix-os.com": 50 },
        users_default: 0,
      });
      const { slug } = await createTestGroup(app);
      const handle = encodeURIComponent("@bob:matrix-os.com");
      const res = await req(app, "PATCH", `/api/groups/${slug}/members/${handle}/role`, { role: "owner" });
      expect(res.status).toBe(403);
    });

    it("returns 400 for invalid role", async () => {
      const { slug } = await createTestGroup(app);
      const handle = encodeURIComponent("@bob:matrix-os.com");
      const res = await req(app, "PATCH", `/api/groups/${slug}/members/${handle}/role`, { role: "superadmin" });
      expect(res.status).toBe(400);
    });

    it("returns 404 for unknown group", async () => {
      const handle = encodeURIComponent("@bob:matrix-os.com");
      const res = await req(app, "PATCH", `/api/groups/nonexistent/members/${handle}/role`, { role: "editor" });
      expect(res.status).toBe(404);
    });

    it("returns 401 without auth", async () => {
      const handle = encodeURIComponent("@bob:matrix-os.com");
      const res = await req(app, "PATCH", `/api/groups/any/members/${handle}/role`, { role: "editor" }, "");
      expect(res.status).toBe(401);
    });
  });

  // ── POST /api/groups/:slug/kick ──────────────────────────────────────────

  describe("POST /api/groups/:slug/kick", () => {
    it("kicks a member and returns 200", async () => {
      const { slug } = await createTestGroup(app);
      const res = await req(app, "POST", `/api/groups/${slug}/kick`, { user_id: "@bob:matrix-os.com" });
      expect(res.status).toBe(200);
    });

    it("calls matrixClient.kickFromRoom", async () => {
      const { slug, room_id } = await createTestGroup(app);
      await req(app, "POST", `/api/groups/${slug}/kick`, { user_id: "@bob:matrix-os.com" });
      expect(matrixClient.kickFromRoom).toHaveBeenCalledWith(room_id, "@bob:matrix-os.com");
    });

    it("returns 403 when caller PL < kick PL", async () => {
      vi.mocked(matrixClient.getPowerLevels).mockResolvedValue({
        users: { "@owner:matrix-os.com": 10 },
        users_default: 0,
        kick: 50,
      });
      const { slug } = await createTestGroup(app);
      const res = await req(app, "POST", `/api/groups/${slug}/kick`, { user_id: "@bob:matrix-os.com" });
      expect(res.status).toBe(403);
    });

    it("returns 400 for invalid user_id format", async () => {
      const { slug } = await createTestGroup(app);
      const res = await req(app, "POST", `/api/groups/${slug}/kick`, { user_id: "notahandle" });
      expect(res.status).toBe(400);
    });

    it("returns 404 for unknown group", async () => {
      const res = await req(app, "POST", "/api/groups/nonexistent/kick", { user_id: "@bob:matrix-os.com" });
      expect(res.status).toBe(404);
    });

    it("returns 401 without auth", async () => {
      const res = await req(app, "POST", "/api/groups/any/kick", { user_id: "@bob:matrix-os.com" }, "");
      expect(res.status).toBe(401);
    });

    it("does not leak internal errors", async () => {
      vi.mocked(matrixClient.kickFromRoom).mockRejectedValue(new Error("M_FORBIDDEN details"));
      const { slug } = await createTestGroup(app);
      const res = await req(app, "POST", `/api/groups/${slug}/kick`, { user_id: "@bob:matrix-os.com" });
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(JSON.stringify(body)).not.toContain("M_FORBIDDEN");
    });
  });

  // ── GET /api/apps (personal apps) ────────────────────────────────────────

  describe("GET /api/apps", () => {
    it("returns empty list when no apps exist", async () => {
      const res = await req(app, "GET", "/api/apps");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.apps).toEqual([]);
    });

    it("lists personal apps with metadata", async () => {
      const appDir = join(tmpHome, "apps", "notes");
      await mkdir(appDir, { recursive: true });
      await writeFile(join(appDir, "meta.json"), JSON.stringify({ name: "My Notes" }));
      await writeFile(join(appDir, "index.html"), "<h1>Notes</h1>");

      const res = await req(app, "GET", "/api/apps");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.apps).toHaveLength(1);
      expect(body.apps[0].slug).toBe("notes");
      expect(body.apps[0].name).toBe("My Notes");
    });

    it("uses directory name as fallback when no meta.json", async () => {
      const appDir = join(tmpHome, "apps", "calculator");
      await mkdir(appDir, { recursive: true });
      await writeFile(join(appDir, "index.html"), "<h1>Calc</h1>");

      const res = await req(app, "GET", "/api/apps");
      const body = await res.json();
      expect(body.apps[0].name).toBe("calculator");
    });

    it("reads icon from meta.json", async () => {
      const appDir = join(tmpHome, "apps", "todo");
      await mkdir(appDir, { recursive: true });
      await writeFile(join(appDir, "meta.json"), JSON.stringify({ name: "Todo", icon: "check-square" }));

      const res = await req(app, "GET", "/api/apps");
      const body = await res.json();
      expect(body.apps[0].icon).toBe("check-square");
    });

    it("skips non-directory entries", async () => {
      await mkdir(join(tmpHome, "apps"), { recursive: true });
      await writeFile(join(tmpHome, "apps", "README.md"), "# Apps");

      const res = await req(app, "GET", "/api/apps");
      const body = await res.json();
      expect(body.apps).toHaveLength(0);
    });

    it("returns 401 without auth", async () => {
      const res = await req(app, "GET", "/api/apps", undefined, "");
      expect(res.status).toBe(401);
    });
  });
});
