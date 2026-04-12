import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createGroupRoutes } from "../../packages/gateway/src/group-routes.js";
import { GroupRegistry } from "../../packages/gateway/src/group-registry.js";
import type { MatrixClient } from "../../packages/gateway/src/matrix-client.js";

const BEARER = "Bearer test-token";

async function makeTmpHome() {
  return mkdtemp(join(tmpdir(), "group-presence-test-"));
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
    getRoomMembers: vi.fn().mockResolvedValue([
      { userId: "@owner:matrix-os.com", membership: "join" },
    ]),
    getPowerLevels: vi.fn().mockResolvedValue({ users: { "@owner:matrix-os.com": 100 }, users_default: 0 }),
    setPowerLevels: vi.fn().mockResolvedValue({ eventId: "$pl1" }),
    ...overrides,
  } as MatrixClient;
}

function makeGroupSync(presenceMap: Map<string, { status: "online" | "unavailable" | "offline"; last_active_ago: number }> = new Map()) {
  return {
    applyLocalMutation: vi.fn(),
    readKv: vi.fn(),
    listKv: vi.fn().mockReturnValue({}),
    getPresence: vi.fn().mockReturnValue(presenceMap),
  };
}

describe("group-routes presence (T075)", () => {
  let tmpHome: string;
  let registry: GroupRegistry;
  let matrixClient: MatrixClient;
  let app: ReturnType<typeof createGroupRoutes>;
  let groupSlug: string;

  beforeEach(async () => {
    tmpHome = await makeTmpHome();
    registry = new GroupRegistry(tmpHome);
    await registry.scan();
    matrixClient = makeMatrixClient();
    app = createGroupRoutes({ matrixClient, groupRegistry: registry, authToken: "test-token", homePath: tmpHome });

    const createRes = await app.request("/api/groups", {
      method: "POST",
      body: JSON.stringify({ name: "Presence Group" }),
      headers: { Authorization: BEARER, "Content-Type": "application/json" },
    });
    const created = await createRes.json();
    groupSlug = created.slug;
  });

  afterEach(async () => {
    await rm(tmpHome, { recursive: true, force: true });
  });

  // ── Auth ────────────────────────────────────────────────────────────────────

  it("returns 401 without auth on GET", async () => {
    const res = await app.request(`/api/groups/${groupSlug}/presence`, {
      method: "GET",
    });
    expect(res.status).toBe(401);
  });

  // ── 404 ─────────────────────────────────────────────────────────────────────

  it("returns 404 for unknown group", async () => {
    const res = await app.request(`/api/groups/nonexistent/presence`, {
      method: "GET",
      headers: { Authorization: BEARER },
    });
    expect(res.status).toBe(404);
  });

  // ── NEGATIVE TEST: No POST route ─────────────────────────────────────────────

  it("POST /presence returns 404 — route does not exist (observe-only)", async () => {
    const res = await app.request(`/api/groups/${groupSlug}/presence`, {
      method: "POST",
      body: JSON.stringify({ status: "online" }),
      headers: { Authorization: BEARER, "Content-Type": "application/json" },
    });
    expect(res.status).toBe(404);
  });

  // ── Happy path ───────────────────────────────────────────────────────────────

  it("returns 200 with presence map from GroupSync", async () => {
    vi.mocked(matrixClient.getRoomMembers).mockResolvedValue([
      { userId: "@alice:m.com", membership: "join" },
      { userId: "@bob:m.com", membership: "join" },
    ]);
    const presenceMap = new Map([
      ["@alice:m.com", { status: "online" as const, last_active_ago: 0 }],
      ["@bob:m.com", { status: "offline" as const, last_active_ago: 60000 }],
    ]);
    const groupSync = makeGroupSync(presenceMap);
    registry.attachSync(groupSlug, groupSync as unknown as Parameters<typeof registry.attachSync>[1]);

    const res = await app.request(`/api/groups/${groupSlug}/presence`, {
      method: "GET",
      headers: { Authorization: BEARER },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.presence["@alice:m.com"].status).toBe("online");
    expect(body.presence["@bob:m.com"].status).toBe("offline");
    expect(body.presence["@bob:m.com"].last_active_ago).toBe(60000);
  });

  it("returns empty presence object when no sync handle attached", async () => {
    const res = await app.request(`/api/groups/${groupSlug}/presence`, {
      method: "GET",
      headers: { Authorization: BEARER },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.presence).toEqual({});
  });

  it("filters presence to group members only", async () => {
    vi.mocked(matrixClient.getRoomMembers).mockResolvedValue([
      { userId: "@alice:m.com", membership: "join" },
    ]);

    const presenceMap = new Map([
      ["@alice:m.com", { status: "online" as const, last_active_ago: 0 }],
      ["@outsider:m.com", { status: "online" as const, last_active_ago: 0 }],
    ]);
    const groupSync = makeGroupSync(presenceMap);
    registry.attachSync(groupSlug, groupSync as unknown as Parameters<typeof registry.attachSync>[1]);

    const res = await app.request(`/api/groups/${groupSlug}/presence`, {
      method: "GET",
      headers: { Authorization: BEARER },
    });
    const body = await res.json();
    expect(Object.keys(body.presence)).toContain("@alice:m.com");
    expect(Object.keys(body.presence)).not.toContain("@outsider:m.com");
  });
});
