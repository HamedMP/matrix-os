import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createGroupRoutes } from "../../packages/gateway/src/group-routes.js";
import { GroupRegistry } from "../../packages/gateway/src/group-registry.js";
import type { MatrixClient } from "../../packages/gateway/src/matrix-client.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

async function makeTmpHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), "group-routes-apps-test-"));
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

describe("group-routes apps list", () => {
  let tmpHome: string;
  let registry: GroupRegistry;
  let matrixClient: MatrixClient;
  let app: ReturnType<typeof createGroupRoutes>;

  beforeEach(async () => {
    tmpHome = await makeTmpHome();
    registry = new GroupRegistry(tmpHome);
    await registry.scan();
    matrixClient = makeMatrixClient();
    app = createGroupRoutes({
      matrixClient,
      groupRegistry: registry,
      authToken: "test-token",
      homePath: tmpHome,
    });

    // Seed a group
    (matrixClient.createRoom as ReturnType<typeof vi.fn>).mockResolvedValue({ roomId: "!fam:matrix-os.com" });
    const createRes = await req(app, "POST", "/api/groups", { name: "Family" });
    expect(createRes.status).toBe(201);
  });

  afterEach(async () => {
    await rm(tmpHome, { recursive: true, force: true });
  });

  it("returns 401 without auth", async () => {
    const res = await req(app, "GET", "/api/groups/family/apps", undefined, "");
    expect(res.status).toBe(401);
  });

  it("returns 404 for unknown group slug", async () => {
    const res = await req(app, "GET", "/api/groups/nonexistent/apps");
    expect(res.status).toBe(404);
  });

  it("returns empty array when no apps directory exists", async () => {
    const res = await req(app, "GET", "/api/groups/family/apps");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.apps).toEqual([]);
  });

  it("returns empty array when apps directory exists but is empty", async () => {
    await mkdir(join(tmpHome, "groups", "family", "apps"), { recursive: true });
    const res = await req(app, "GET", "/api/groups/family/apps");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.apps).toEqual([]);
  });

  it("returns app slugs from directory names", async () => {
    const appsDir = join(tmpHome, "groups", "family", "apps");
    await mkdir(join(appsDir, "notes"), { recursive: true });
    await mkdir(join(appsDir, "todo"), { recursive: true });

    const res = await req(app, "GET", "/api/groups/family/apps");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.apps).toHaveLength(2);
    const slugs = data.apps.map((a: { slug: string }) => a.slug).sort();
    expect(slugs).toEqual(["notes", "todo"]);
  });

  it("reads app name from meta.json when present", async () => {
    const appsDir = join(tmpHome, "groups", "family", "apps");
    await mkdir(join(appsDir, "notes"), { recursive: true });
    await writeFile(join(appsDir, "notes", "meta.json"), JSON.stringify({ name: "My Notes" }));

    const res = await req(app, "GET", "/api/groups/family/apps");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.apps).toHaveLength(1);
    expect(data.apps[0]).toEqual({ slug: "notes", name: "My Notes" });
  });

  it("falls back to slug as name when meta.json is missing", async () => {
    const appsDir = join(tmpHome, "groups", "family", "apps");
    await mkdir(join(appsDir, "todo"), { recursive: true });

    const res = await req(app, "GET", "/api/groups/family/apps");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.apps[0]).toEqual({ slug: "todo", name: "todo" });
  });

  it("falls back to slug when meta.json is invalid JSON", async () => {
    const appsDir = join(tmpHome, "groups", "family", "apps");
    await mkdir(join(appsDir, "broken-app"), { recursive: true });
    await writeFile(join(appsDir, "broken-app", "meta.json"), "not-json{{{");

    const res = await req(app, "GET", "/api/groups/family/apps");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.apps[0].slug).toBe("broken-app");
    expect(data.apps[0].name).toBe("broken-app");
  });

  it("skips non-directory entries in apps folder", async () => {
    const appsDir = join(tmpHome, "groups", "family", "apps");
    await mkdir(appsDir, { recursive: true });
    await writeFile(join(appsDir, "readme.txt"), "ignore me");
    await mkdir(join(appsDir, "notes"), { recursive: true });

    const res = await req(app, "GET", "/api/groups/family/apps");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.apps).toHaveLength(1);
    expect(data.apps[0].slug).toBe("notes");
  });
});
