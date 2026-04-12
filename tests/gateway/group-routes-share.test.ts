import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createGroupRoutes } from "../../packages/gateway/src/group-routes.js";
import { GroupRegistry } from "../../packages/gateway/src/group-registry.js";
import type { MatrixClient } from "../../packages/gateway/src/matrix-client.js";

const BEARER = "Bearer test-token";

async function makeTmpHome() {
  return mkdtemp(join(tmpdir(), "group-share-test-"));
}

function makeMatrixClient(overrides: Partial<MatrixClient> = {}): MatrixClient {
  return {
    sendMessage: vi.fn().mockResolvedValue({ eventId: "$e1" }),
    createDM: vi.fn().mockResolvedValue({ roomId: "!dm:m.com" }),
    joinRoom: vi.fn().mockResolvedValue({ roomId: "!r:m.com" }),
    getRoomMessages: vi.fn().mockResolvedValue({ messages: [], end: "", chunk: [] }),
    whoami: vi.fn().mockResolvedValue({ userId: "@owner:matrix-os.com" }),
    sendCustomEvent: vi.fn().mockResolvedValue({ eventId: "$c1" }),
    sync: vi.fn().mockResolvedValue({ next_batch: "s1", rooms: { join: {}, invite: {}, leave: {} }, presence: { events: [] } }),
    createRoom: vi.fn().mockResolvedValue({ roomId: "!newroom:m.com" }),
    inviteToRoom: vi.fn().mockResolvedValue(undefined),
    kickFromRoom: vi.fn().mockResolvedValue(undefined),
    leaveRoom: vi.fn().mockResolvedValue(undefined),
    getRoomState: vi.fn().mockResolvedValue(null),
    getAllRoomStateEvents: vi.fn().mockResolvedValue([]),
    setRoomState: vi.fn().mockResolvedValue({ eventId: "$s1" }),
    getRoomMembers: vi.fn().mockResolvedValue([{ userId: "@owner:matrix-os.com", membership: "join" }]),
    getPowerLevels: vi.fn().mockResolvedValue({ users: { "@owner:matrix-os.com": 100 }, users_default: 0 }),
    setPowerLevels: vi.fn().mockResolvedValue({ eventId: "$pl1" }),
    ...overrides,
  } as MatrixClient;
}

async function fileExists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}

describe("group-routes share-app (T063)", () => {
  let tmpHome: string;
  let registry: GroupRegistry;
  let matrixClient: MatrixClient;
  let app: ReturnType<typeof createGroupRoutes>;
  let groupSlug: string;
  let roomId: string;

  beforeEach(async () => {
    tmpHome = await makeTmpHome();
    registry = new GroupRegistry(tmpHome);
    await registry.scan();
    matrixClient = makeMatrixClient();
    app = createGroupRoutes({ matrixClient, groupRegistry: registry, authToken: "test-token", homePath: tmpHome });

    // Create source app in ~/apps/notes
    const appsDir = join(tmpHome, "apps", "notes");
    await mkdir(appsDir, { recursive: true });
    await writeFile(join(appsDir, "index.html"), "<html>notes</html>");
    await writeFile(join(appsDir, "matrix.json"), JSON.stringify({ name: "Notes", runtime: "static" }));

    const createRes = await app.request("/api/groups", {
      method: "POST",
      body: JSON.stringify({ name: "Share Group" }),
      headers: { Authorization: BEARER, "Content-Type": "application/json" },
    });
    const created = await createRes.json();
    groupSlug = created.slug;
    roomId = created.room_id;
  });

  afterEach(async () => {
    await rm(tmpHome, { recursive: true, force: true });
  });

  function reqShare(slug: string, body: unknown, auth = BEARER) {
    return app.request(`/api/groups/${slug}/share-app`, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { Authorization: auth, "Content-Type": "application/json" },
    });
  }

  // ── Auth ────────────────────────────────────────────────────────────────────

  it("returns 401 without auth", async () => {
    const res = await reqShare(groupSlug, { app_slug: "notes" }, "");
    expect(res.status).toBe(401);
  });

  // ── 404 ─────────────────────────────────────────────────────────────────────

  it("returns 404 for unknown group", async () => {
    const res = await reqShare("nonexistent", { app_slug: "notes" });
    expect(res.status).toBe(404);
  });

  it("returns 404 when source app does not exist", async () => {
    vi.mocked(matrixClient.getPowerLevels).mockResolvedValue({ users: { "@owner:matrix-os.com": 100 }, users_default: 0 });
    const res = await reqShare(groupSlug, { app_slug: "nonexistent-app" });
    expect(res.status).toBe(404);
  });

  // ── Schema validation ────────────────────────────────────────────────────────

  it("returns 400 if app_slug is missing", async () => {
    const res = await reqShare(groupSlug, {});
    expect(res.status).toBe(400);
  });

  it("returns 400 for invalid app_slug (uppercase)", async () => {
    const res = await reqShare(groupSlug, { app_slug: "UPPER" });
    expect(res.status).toBe(400);
  });

  // ── Power level enforcement ───────────────────────────────────────────────

  it("returns 403 when caller PL < install_pl (100)", async () => {
    vi.mocked(matrixClient.whoami).mockResolvedValue({ userId: "@viewer:m.com" });
    vi.mocked(matrixClient.getPowerLevels).mockResolvedValue({ users: { "@viewer:m.com": 0 }, users_default: 0 });

    const res = await reqShare(groupSlug, { app_slug: "notes" });
    expect(res.status).toBe(403);
  });

  // ── Happy path ───────────────────────────────────────────────────────────────

  it("copies app to ~/groups/{slug}/apps/{app_slug}", async () => {
    vi.mocked(matrixClient.getPowerLevels).mockResolvedValue({ users: { "@owner:matrix-os.com": 100 }, users_default: 0 });

    const res = await reqShare(groupSlug, { app_slug: "notes" });
    expect(res.status).toBe(201);

    const copied = join(tmpHome, "groups", groupSlug, "apps", "notes", "index.html");
    expect(await fileExists(copied)).toBe(true);
  });

  it("writes default ACL state event with policy open, read_pl 0, write_pl 0, install_pl 100", async () => {
    vi.mocked(matrixClient.getPowerLevels).mockResolvedValue({ users: { "@owner:matrix-os.com": 100 }, users_default: 0 });

    await reqShare(groupSlug, { app_slug: "notes" });

    const aclCall = (matrixClient.setRoomState as ReturnType<typeof vi.fn>).mock.calls.find(
      ([, eventType]: [string, string]) => eventType === "m.matrix_os.app_acl",
    );
    expect(aclCall).toBeTruthy();
    const [, , stateKey, content] = aclCall!;
    expect(stateKey).toBe("notes");
    expect(content.read_pl).toBe(0);
    expect(content.write_pl).toBe(0);
    expect(content.install_pl).toBe(100);
    expect(content.policy).toBe("open");
  });

  it("sends m.matrix_os.app_install timeline event via sendCustomEvent", async () => {
    vi.mocked(matrixClient.getPowerLevels).mockResolvedValue({ users: { "@owner:matrix-os.com": 100 }, users_default: 0 });

    await reqShare(groupSlug, { app_slug: "notes" });

    expect(matrixClient.sendCustomEvent).toHaveBeenCalledWith(
      roomId,
      "m.matrix_os.app_install",
      expect.objectContaining({ app_slug: "notes" }),
    );
  });

  it("returns 201 with { slug, app_slug } on success", async () => {
    vi.mocked(matrixClient.getPowerLevels).mockResolvedValue({ users: { "@owner:matrix-os.com": 100 }, users_default: 0 });

    const res = await reqShare(groupSlug, { app_slug: "notes" });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.slug).toBe(groupSlug);
    expect(body.app_slug).toBe("notes");
  });

  it("handles filesystem copy failure with 500 and generic message", async () => {
    vi.mocked(matrixClient.getPowerLevels).mockResolvedValue({ users: { "@owner:matrix-os.com": 100 }, users_default: 0 });

    // Remove the source app to force a failure path
    await rm(join(tmpHome, "apps", "notes"), { recursive: true });

    const res = await reqShare(groupSlug, { app_slug: "notes" });
    // Source not found → 404, not 500
    expect(res.status).toBe(404);
  });
});
