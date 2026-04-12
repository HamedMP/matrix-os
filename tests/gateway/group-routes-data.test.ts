import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createGroupRoutes } from "../../packages/gateway/src/group-routes.js";
import { GroupRegistry } from "../../packages/gateway/src/group-registry.js";
import type { MatrixClient } from "../../packages/gateway/src/matrix-client.js";

const BEARER = "Bearer test-token";

async function makeTmpHome() {
  return mkdtemp(join(tmpdir(), "group-data-test-"));
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

// Minimal GroupSync stub that satisfies the data route interface
function makeGroupSync(kvStore: Record<string, unknown> = {}) {
  const makeYMap = () => ({
    get: (key: string) => kvStore[key],
    set: (key: string, value: unknown) => { kvStore[key] = value; },
    forEach: (cb: (value: unknown, key: string) => void) => {
      for (const [k, v] of Object.entries(kvStore)) cb(v, k);
    },
  });
  const fakeDoc = { getMap: (name: string) => name === "kv" ? makeYMap() : makeYMap() };
  return {
    applyLocalMutation: vi.fn().mockImplementation(
      async (_appSlug: string, mutator: (doc: typeof fakeDoc) => void) => {
        mutator(fakeDoc);
      },
    ),
    getDoc: vi.fn().mockReturnValue(fakeDoc),
    getPresence: vi.fn().mockReturnValue({}),
  };
}

function reqData(
  app: ReturnType<typeof createGroupRoutes>,
  slug: string,
  body: unknown,
) {
  return app.request(`/api/groups/${slug}/data`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { Authorization: BEARER, "Content-Type": "application/json" },
  });
}

describe("group-routes data (T078)", () => {
  let tmpHome: string;
  let registry: GroupRegistry;
  let matrixClient: MatrixClient;
  let app: ReturnType<typeof createGroupRoutes>;
  let groupSlug: string;
  let groupSync: ReturnType<typeof makeGroupSync>;

  beforeEach(async () => {
    tmpHome = await makeTmpHome();
    registry = new GroupRegistry(tmpHome);
    await registry.scan();
    matrixClient = makeMatrixClient();
    groupSync = makeGroupSync();
    app = createGroupRoutes({ matrixClient, groupRegistry: registry, authToken: "test-token" });

    // Create a group and attach a sync handle
    const createRes = await app.request("/api/groups", {
      method: "POST",
      body: JSON.stringify({ name: "Data Group" }),
      headers: { Authorization: BEARER, "Content-Type": "application/json" },
    });
    const created = await createRes.json();
    groupSlug = created.slug;
    registry.attachSync(groupSlug, groupSync as unknown as Parameters<typeof registry.attachSync>[1]);
  });

  afterEach(async () => {
    await rm(tmpHome, { recursive: true, force: true });
  });

  // ── Auth ────────────────────────────────────────────────────────────────────

  it("returns 401 without auth", async () => {
    const res = await app.request(`/api/groups/${groupSlug}/data`, {
      method: "POST",
      body: JSON.stringify({ action: "list", app_slug: "my-app" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(401);
  });

  // ── 404 ─────────────────────────────────────────────────────────────────────

  it("returns 404 for unknown group slug", async () => {
    const res = await reqData(app, "nonexistent", { action: "list", app_slug: "my-app" });
    expect(res.status).toBe(404);
  });

  // ── Schema validation ────────────────────────────────────────────────────────

  it("returns 400 for invalid action", async () => {
    const res = await reqData(app, groupSlug, { action: "delete", app_slug: "my-app", key: "k" });
    expect(res.status).toBe(400);
  });

  it("returns 400 for read without key", async () => {
    const res = await reqData(app, groupSlug, { action: "read", app_slug: "my-app" });
    expect(res.status).toBe(400);
  });

  it("returns 400 for write without key", async () => {
    const res = await reqData(app, groupSlug, { action: "write", app_slug: "my-app", value: "v" });
    expect(res.status).toBe(400);
  });

  it("returns 400 for write without value", async () => {
    const res = await reqData(app, groupSlug, { action: "write", app_slug: "my-app", key: "k" });
    expect(res.status).toBe(400);
  });

  it("returns 400 for invalid app_slug (uppercase)", async () => {
    const res = await reqData(app, groupSlug, { action: "list", app_slug: "UPPER" });
    expect(res.status).toBe(400);
  });

  it("400 response does not leak Zod error details", async () => {
    const res = await reqData(app, groupSlug, { action: "bad", app_slug: "my-app" });
    const body = await res.json();
    expect(body.error).toBeDefined();
    // No Zod internal details
    expect(JSON.stringify(body)).not.toContain("ZodError");
    expect(JSON.stringify(body)).not.toContain("invalid_union");
  });

  // ── Body limit ───────────────────────────────────────────────────────────────

  it("rejects body > 512 KB with 413", async () => {
    const bigBody = JSON.stringify({ action: "write", app_slug: "my-app", key: "k", value: "x".repeat(513 * 1024) });
    const res = await app.request(`/api/groups/${groupSlug}/data`, {
      method: "POST",
      body: bigBody,
      headers: {
        Authorization: BEARER,
        "Content-Type": "application/json",
        "Content-Length": String(Buffer.byteLength(bigBody)),
      },
    });
    expect(res.status).toBe(413);
  });

  it("rejects value > 256 KB with 400 (schema fires before bodyLimit for 257KB body)", async () => {
    // 257KB value but total body ~257KB — under 512KB bodyLimit, so schema fires
    const bigValue = "x".repeat(257 * 1024);
    const res = await reqData(app, groupSlug, { action: "write", app_slug: "my-app", key: "k", value: bigValue });
    expect(res.status).toBe(400);
  });

  // ── write action ─────────────────────────────────────────────────────────────

  it("write calls applyLocalMutation on the group sync handle", async () => {
    const res = await reqData(app, groupSlug, {
      action: "write",
      app_slug: "my-app",
      key: "note1",
      value: "hello",
    });
    expect(res.status).toBe(200);
    expect(groupSync.applyLocalMutation).toHaveBeenCalledTimes(1);
    const [slug, _mutator] = (groupSync.applyLocalMutation as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(slug).toBe("my-app");
  });

  it("write returns { ok: true }", async () => {
    const res = await reqData(app, groupSlug, {
      action: "write",
      app_slug: "my-app",
      key: "k",
      value: 42,
    });
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  // ── read action ──────────────────────────────────────────────────────────────

  it("read calls getDoc and returns the value", async () => {
    // Seed the kvStore via a write first
    await reqData(app, groupSlug, { action: "write", app_slug: "my-app", key: "note1", value: "stored-value" });
    const res = await reqData(app, groupSlug, {
      action: "read",
      app_slug: "my-app",
      key: "note1",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.value).toBe("stored-value");
    expect(groupSync.getDoc).toHaveBeenCalledWith("my-app");
  });

  it("read returns { value: null } when key not found", async () => {
    const res = await reqData(app, groupSlug, {
      action: "read",
      app_slug: "my-app",
      key: "missing",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.value).toBeNull();
  });

  // ── list action ──────────────────────────────────────────────────────────────

  it("list calls getDoc and returns all entries", async () => {
    // Seed via write
    await reqData(app, groupSlug, { action: "write", app_slug: "my-app", key: "a", value: 1 });
    await reqData(app, groupSlug, { action: "write", app_slug: "my-app", key: "b", value: "two" });
    const res = await reqData(app, groupSlug, {
      action: "list",
      app_slug: "my-app",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.entries).toEqual({ a: 1, b: "two" });
    expect(groupSync.getDoc).toHaveBeenCalledWith("my-app");
  });

  // ── no sync handle ───────────────────────────────────────────────────────────

  it("returns 503 if group has no sync handle attached", async () => {
    // Create a second group without attaching sync
    const createRes = await app.request("/api/groups", {
      method: "POST",
      body: JSON.stringify({ name: "No Sync Group" }),
      headers: { Authorization: BEARER, "Content-Type": "application/json" },
    });
    const { slug } = await createRes.json();

    const res = await reqData(app, slug, { action: "list", app_slug: "my-app" });
    expect(res.status).toBe(503);
  });
});
