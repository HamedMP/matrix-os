import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createGroupRoutes } from "../../packages/gateway/src/group-routes.js";
import { GroupRegistry } from "../../packages/gateway/src/group-registry.js";
import type { MatrixClient, PowerLevelsContent } from "../../packages/gateway/src/matrix-client.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

async function makeTmpHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), "group-routes-invite-test-"));
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
      invite: 0,
    } satisfies PowerLevelsContent),
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

describe("group-routes invite", () => {
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

    // Seed a group so invite tests have something to work with
    (matrixClient.createRoom as ReturnType<typeof vi.fn>).mockResolvedValue({ roomId: "!fam:matrix-os.com" });
    const createRes = await req(app, "POST", "/api/groups", { name: "Family" });
    expect(createRes.status).toBe(201);
  });

  afterEach(async () => {
    await rm(tmpHome, { recursive: true, force: true });
  });

  it("returns 401 without auth", async () => {
    const res = await req(app, "POST", "/api/groups/family/invite", { user_id: "@bob:matrix-os.com" }, "");
    expect(res.status).toBe(401);
  });

  it("returns 404 for unknown group slug", async () => {
    const res = await req(app, "POST", "/api/groups/nonexistent/invite", { user_id: "@bob:matrix-os.com" });
    expect(res.status).toBe(404);
  });

  it("returns 400 for invalid handle format", async () => {
    const res = await req(app, "POST", "/api/groups/family/invite", { user_id: "not-a-handle" });
    expect(res.status).toBe(400);
  });

  it("returns 400 for missing user_id", async () => {
    const res = await req(app, "POST", "/api/groups/family/invite", {});
    expect(res.status).toBe(400);
  });

  it("returns 400 for invalid JSON body", async () => {
    const headers: Record<string, string> = {
      Authorization: BEARER,
      "Content-Type": "application/json",
    };
    const res = await app.request("/api/groups/family/invite", {
      method: "POST",
      headers,
      body: "not-json{{{",
    });
    expect(res.status).toBe(400);
  });

  it("returns 200 and calls inviteToRoom on success", async () => {
    const res = await req(app, "POST", "/api/groups/family/invite", { user_id: "@bob:matrix-os.com" });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(matrixClient.inviteToRoom).toHaveBeenCalledWith("!fam:matrix-os.com", "@bob:matrix-os.com");
  });

  it("returns 403 when caller PL < invite PL", async () => {
    // Reconfigure: caller has PL 0, invite requires PL 50
    (matrixClient.whoami as ReturnType<typeof vi.fn>).mockResolvedValue({ userId: "@viewer:matrix-os.com" });
    (matrixClient.getPowerLevels as ReturnType<typeof vi.fn>).mockResolvedValue({
      users: { "@owner:matrix-os.com": 100 },
      users_default: 0,
      invite: 50,
    } satisfies PowerLevelsContent);

    const res = await req(app, "POST", "/api/groups/family/invite", { user_id: "@charlie:matrix-os.com" });
    expect(res.status).toBe(403);
    expect(matrixClient.inviteToRoom).not.toHaveBeenCalled();
  });

  it("returns 403 when caller has default PL and invite PL > 0", async () => {
    // caller not in users map, uses users_default=0, invite=25
    (matrixClient.whoami as ReturnType<typeof vi.fn>).mockResolvedValue({ userId: "@newuser:matrix-os.com" });
    (matrixClient.getPowerLevels as ReturnType<typeof vi.fn>).mockResolvedValue({
      users: { "@owner:matrix-os.com": 100 },
      users_default: 0,
      invite: 25,
    } satisfies PowerLevelsContent);

    const res = await req(app, "POST", "/api/groups/family/invite", { user_id: "@bob:matrix-os.com" });
    expect(res.status).toBe(403);
  });

  it("succeeds when invite PL is 0 (private_chat default)", async () => {
    // Any member can invite when invite PL is 0
    (matrixClient.whoami as ReturnType<typeof vi.fn>).mockResolvedValue({ userId: "@viewer:matrix-os.com" });
    (matrixClient.getPowerLevels as ReturnType<typeof vi.fn>).mockResolvedValue({
      users: { "@owner:matrix-os.com": 100 },
      users_default: 0,
      invite: 0,
    } satisfies PowerLevelsContent);

    const res = await req(app, "POST", "/api/groups/family/invite", { user_id: "@bob:matrix-os.com" });
    expect(res.status).toBe(200);
    expect(matrixClient.inviteToRoom).toHaveBeenCalled();
  });

  it("returns 500 when inviteToRoom throws", async () => {
    (matrixClient.inviteToRoom as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("Matrix error"));
    const res = await req(app, "POST", "/api/groups/family/invite", { user_id: "@bob:matrix-os.com" });
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.error).toBeDefined();
    // Must not leak internal error message
    expect(data.error).not.toContain("Matrix error");
  });

  it("returns 400 for slug with invalid characters", async () => {
    const res = await req(app, "POST", "/api/groups/INVALID_SLUG!/invite", { user_id: "@bob:matrix-os.com" });
    expect(res.status).toBe(404);
  });
});
