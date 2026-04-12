import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createGroupRoutes } from "../../packages/gateway/src/group-routes.js";
import { GroupRegistry } from "../../packages/gateway/src/group-registry.js";
import type { MatrixClient } from "../../packages/gateway/src/matrix-client.js";

const BEARER = "Bearer test-token";

async function makeTmpHome() {
  return mkdtemp(join(tmpdir(), "group-members-test-"));
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

describe("group-routes members (T072)", () => {
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

    const createRes = await app.request("/api/groups", {
      method: "POST",
      body: JSON.stringify({ name: "Members Group" }),
      headers: { Authorization: BEARER, "Content-Type": "application/json" },
    });
    const created = await createRes.json();
    groupSlug = created.slug;
    roomId = created.room_id;
  });

  afterEach(async () => {
    await rm(tmpHome, { recursive: true, force: true });
  });

  function reqMembers(slug: string, auth = BEARER) {
    return app.request(`/api/groups/${slug}/members`, {
      method: "GET",
      headers: { Authorization: auth },
    });
  }

  // ── Auth ────────────────────────────────────────────────────────────────────

  it("returns 401 without auth", async () => {
    const res = await reqMembers(groupSlug, "");
    expect(res.status).toBe(401);
  });

  // ── 404 ─────────────────────────────────────────────────────────────────────

  it("returns 404 for unknown group", async () => {
    const res = await reqMembers("nonexistent");
    expect(res.status).toBe(404);
  });

  // ── Role bucketing ───────────────────────────────────────────────────────────

  it("assigns owner role for PL ≥ 75", async () => {
    vi.mocked(matrixClient.getRoomMembers).mockResolvedValue([
      { userId: "@owner:m.com", membership: "join" },
    ]);
    vi.mocked(matrixClient.getPowerLevels).mockResolvedValue({
      users: { "@owner:m.com": 100 },
      users_default: 0,
    });

    const res = await reqMembers(groupSlug);
    expect(res.status).toBe(200);
    const body = await res.json();
    const member = body.members.find((m: { user_id: string }) => m.user_id === "@owner:m.com");
    expect(member?.role).toBe("owner");
  });

  it("assigns editor role for PL ≥ 25 and < 75", async () => {
    vi.mocked(matrixClient.getRoomMembers).mockResolvedValue([
      { userId: "@editor:m.com", membership: "join" },
    ]);
    vi.mocked(matrixClient.getPowerLevels).mockResolvedValue({
      users: { "@editor:m.com": 50 },
      users_default: 0,
    });

    const res = await reqMembers(groupSlug);
    const body = await res.json();
    const member = body.members.find((m: { user_id: string }) => m.user_id === "@editor:m.com");
    expect(member?.role).toBe("editor");
  });

  it("assigns viewer role for PL < 25", async () => {
    vi.mocked(matrixClient.getRoomMembers).mockResolvedValue([
      { userId: "@viewer:m.com", membership: "join" },
    ]);
    vi.mocked(matrixClient.getPowerLevels).mockResolvedValue({
      users: {},
      users_default: 0,
    });

    const res = await reqMembers(groupSlug);
    const body = await res.json();
    const member = body.members.find((m: { user_id: string }) => m.user_id === "@viewer:m.com");
    expect(member?.role).toBe("viewer");
  });

  it("uses users_default PL when user not in users map", async () => {
    vi.mocked(matrixClient.getRoomMembers).mockResolvedValue([
      { userId: "@newuser:m.com", membership: "join" },
    ]);
    vi.mocked(matrixClient.getPowerLevels).mockResolvedValue({
      users: {},
      users_default: 50,
    });

    const res = await reqMembers(groupSlug);
    const body = await res.json();
    const member = body.members.find((m: { user_id: string }) => m.user_id === "@newuser:m.com");
    expect(member?.role).toBe("editor");
  });

  // ── Response shape ───────────────────────────────────────────────────────────

  it("returns 200 with members array containing user_id, role, membership", async () => {
    vi.mocked(matrixClient.getRoomMembers).mockResolvedValue([
      { userId: "@alice:m.com", membership: "join" },
      { userId: "@bob:m.com", membership: "invite" },
    ]);
    vi.mocked(matrixClient.getPowerLevels).mockResolvedValue({
      users: { "@alice:m.com": 100, "@bob:m.com": 0 },
      users_default: 0,
    });

    const res = await reqMembers(groupSlug);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.members)).toBe(true);
    const alice = body.members.find((m: { user_id: string }) => m.user_id === "@alice:m.com");
    expect(alice).toMatchObject({ user_id: "@alice:m.com", role: "owner", membership: "join" });
  });

  it("only includes join and invite members (excludes leave/ban)", async () => {
    vi.mocked(matrixClient.getRoomMembers).mockResolvedValue([
      { userId: "@active:m.com", membership: "join" },
      { userId: "@invited:m.com", membership: "invite" },
      { userId: "@left:m.com", membership: "leave" },
      { userId: "@banned:m.com", membership: "ban" },
    ]);
    vi.mocked(matrixClient.getPowerLevels).mockResolvedValue({ users: {}, users_default: 0 });

    const res = await reqMembers(groupSlug);
    const body = await res.json();
    const ids = body.members.map((m: { user_id: string }) => m.user_id);
    expect(ids).toContain("@active:m.com");
    expect(ids).toContain("@invited:m.com");
    expect(ids).not.toContain("@left:m.com");
    expect(ids).not.toContain("@banned:m.com");
  });

  // ── Cache fallback ───────────────────────────────────────────────────────────

  it("writes members.cache.json after successful fetch", async () => {
    vi.mocked(matrixClient.getRoomMembers).mockResolvedValue([
      { userId: "@owner:m.com", membership: "join" },
    ]);
    vi.mocked(matrixClient.getPowerLevels).mockResolvedValue({
      users: { "@owner:m.com": 100 },
      users_default: 0,
    });

    await reqMembers(groupSlug);

    const cachePath = join(tmpHome, "groups", groupSlug, "members.cache.json");
    const raw = await readFile(cachePath, "utf8");
    const cached = JSON.parse(raw);
    expect(Array.isArray(cached.members)).toBe(true);
    expect(cached.members[0].user_id).toBe("@owner:m.com");
  });

  it("returns cached members when Matrix fetch fails", async () => {
    // Pre-write a cache file
    const groupDir = join(tmpHome, "groups", groupSlug);
    await mkdir(groupDir, { recursive: true });
    await writeFile(
      join(groupDir, "members.cache.json"),
      JSON.stringify({ members: [{ user_id: "@cached:m.com", role: "owner", membership: "join" }] }),
    );

    vi.mocked(matrixClient.getRoomMembers).mockRejectedValue(new Error("network error"));

    const res = await reqMembers(groupSlug);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.members[0].user_id).toBe("@cached:m.com");
    expect(body.from_cache).toBe(true);
  });

  it("returns 503 when Matrix fails and no cache exists", async () => {
    vi.mocked(matrixClient.getRoomMembers).mockRejectedValue(new Error("network error"));

    const res = await reqMembers(groupSlug);
    expect(res.status).toBe(503);
  });
});
