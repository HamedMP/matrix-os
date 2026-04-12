import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createGroupRoutes } from "../../packages/gateway/src/group-routes.js";
import { GroupRegistry } from "../../packages/gateway/src/group-registry.js";
import type { MatrixClient, PowerLevelsContent } from "../../packages/gateway/src/matrix-client.js";

const BEARER = "Bearer test-token";

async function makeTmpHome() {
  return mkdtemp(join(tmpdir(), "group-acl-test-"));
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

describe("group-routes ACL (T058)", () => {
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
    app = createGroupRoutes({ matrixClient, groupRegistry: registry, authToken: "test-token" });

    const createRes = await app.request("/api/groups", {
      method: "POST",
      body: JSON.stringify({ name: "ACL Group" }),
      headers: { Authorization: BEARER, "Content-Type": "application/json" },
    });
    const created = await createRes.json();
    groupSlug = created.slug;
    roomId = created.room_id;
  });

  afterEach(async () => {
    await rm(tmpHome, { recursive: true, force: true });
  });

  function reqAcl(slug: string, appSlug: string, body: unknown, auth = BEARER) {
    return app.request(`/api/groups/${slug}/apps/${appSlug}/acl`, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { Authorization: auth, "Content-Type": "application/json" },
    });
  }

  const validAcl = { read_pl: 0, write_pl: 0, install_pl: 100, policy: "open" };

  // ── Auth ────────────────────────────────────────────────────────────────────

  it("returns 401 without auth", async () => {
    const res = await reqAcl(groupSlug, "my-app", validAcl, "");
    expect(res.status).toBe(401);
  });

  // ── 404 ─────────────────────────────────────────────────────────────────────

  it("returns 404 for unknown group", async () => {
    const res = await reqAcl("nonexistent", "my-app", validAcl);
    expect(res.status).toBe(404);
  });

  // ── Schema validation ────────────────────────────────────────────────────────

  it("returns 400 for invalid policy", async () => {
    const res = await reqAcl(groupSlug, "my-app", { ...validAcl, policy: "public" });
    expect(res.status).toBe(400);
  });

  it("returns 400 for missing install_pl", async () => {
    const res = await reqAcl(groupSlug, "my-app", { read_pl: 0, write_pl: 0, policy: "open" });
    expect(res.status).toBe(400);
  });

  it("returns 400 for non-numeric power levels", async () => {
    const res = await reqAcl(groupSlug, "my-app", { ...validAcl, write_pl: "fifty" });
    expect(res.status).toBe(400);
  });

  // ── Power level enforcement ───────────────────────────────────────────────

  it("returns 403 when caller power level is below install_pl (100)", async () => {
    vi.mocked(matrixClient.whoami).mockResolvedValue({ userId: "@editor:matrix-os.com" });
    const plContent: PowerLevelsContent = { users: { "@editor:matrix-os.com": 50 }, users_default: 0 };
    vi.mocked(matrixClient.getPowerLevels).mockResolvedValue(plContent);

    const res = await reqAcl(groupSlug, "my-app", validAcl);
    expect(res.status).toBe(403);
  });

  it("succeeds when caller has power level 100 (owner)", async () => {
    vi.mocked(matrixClient.whoami).mockResolvedValue({ userId: "@owner:matrix-os.com" });
    vi.mocked(matrixClient.getPowerLevels).mockResolvedValue({
      users: { "@owner:matrix-os.com": 100 },
      users_default: 0,
    });

    const res = await reqAcl(groupSlug, "my-app", validAcl);
    expect(res.status).toBe(200);
  });

  it("403 response is generic — no Matrix details", async () => {
    vi.mocked(matrixClient.whoami).mockResolvedValue({ userId: "@viewer:matrix-os.com" });
    vi.mocked(matrixClient.getPowerLevels).mockResolvedValue({ users: {}, users_default: 0 });

    const res = await reqAcl(groupSlug, "my-app", validAcl);
    const body = await res.json();
    expect(body.error).toBeDefined();
    expect(JSON.stringify(body)).not.toContain("Matrix");
  });

  // ── setRoomState call ────────────────────────────────────────────────────────

  it("calls setRoomState with event type m.matrix_os.app_acl and state_key = app_slug (not empty string)", async () => {
    vi.mocked(matrixClient.whoami).mockResolvedValue({ userId: "@owner:matrix-os.com" });
    vi.mocked(matrixClient.getPowerLevels).mockResolvedValue({ users: { "@owner:matrix-os.com": 100 }, users_default: 0 });

    await reqAcl(groupSlug, "notes-app", validAcl);

    expect(matrixClient.setRoomState).toHaveBeenCalledWith(
      roomId,
      "m.matrix_os.app_acl",
      "notes-app",       // state_key = app_slug per spike §10 typo fix
      expect.objectContaining({ policy: "open" }),
    );
  });

  it("stores v:1 in the ACL state event", async () => {
    vi.mocked(matrixClient.whoami).mockResolvedValue({ userId: "@owner:matrix-os.com" });
    vi.mocked(matrixClient.getPowerLevels).mockResolvedValue({ users: { "@owner:matrix-os.com": 100 }, users_default: 0 });

    await reqAcl(groupSlug, "my-app", validAcl);

    const [, , , content] = (matrixClient.setRoomState as ReturnType<typeof vi.fn>).mock.calls.at(-1)!;
    expect(content.v).toBe(1);
  });

  it("returns 200 with ok:true on success", async () => {
    vi.mocked(matrixClient.whoami).mockResolvedValue({ userId: "@owner:matrix-os.com" });
    vi.mocked(matrixClient.getPowerLevels).mockResolvedValue({ users: { "@owner:matrix-os.com": 100 }, users_default: 0 });

    const res = await reqAcl(groupSlug, "my-app", validAcl);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it("handles setRoomState failure with 500 and generic message", async () => {
    vi.mocked(matrixClient.whoami).mockResolvedValue({ userId: "@owner:matrix-os.com" });
    vi.mocked(matrixClient.getPowerLevels).mockResolvedValue({ users: { "@owner:matrix-os.com": 100 }, users_default: 0 });
    vi.mocked(matrixClient.setRoomState).mockRejectedValue(new Error("M_FORBIDDEN internal detail"));

    const res = await reqAcl(groupSlug, "my-app", validAcl);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain("M_FORBIDDEN internal detail");
  });

  // ── bodyLimit ────────────────────────────────────────────────────────────────

  it("applies bodyLimit — rejects body > 256 KB", async () => {
    const bigBody = JSON.stringify({ ...validAcl, extra: "x".repeat(300 * 1024) });
    const res = await app.request(`/api/groups/${groupSlug}/apps/my-app/acl`, {
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
});
