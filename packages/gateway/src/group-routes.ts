import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cp, writeFile, readFile, mkdir } from "node:fs/promises";
import { z } from "zod/v4";
import type { MatrixClient } from "./matrix-client.js";
import type { GroupRegistry } from "./group-registry.js";
import { GroupDataRequestSchema, GroupAclSchema } from "./group-types.js";
import { resolveWithinHome } from "./path-security.js";

export interface GroupRoutesOptions {
  matrixClient: MatrixClient;
  groupRegistry: GroupRegistry;
  /** Bearer token expected in Authorization header. If omitted, any non-empty token passes. */
  authToken?: string;
  /** Absolute path to the user's home directory. Required for share-app route. */
  homePath?: string;
}

const BODY_LIMIT = 256 * 1024;
const DATA_BODY_LIMIT = 512 * 1024;

// Minimal sync-handle surface consumed by routes. GroupSync satisfies this
// structurally; defined here so routes compile even before crdt-engine lands
// the full class.
interface GroupSyncHandle {
  applyLocalMutation(appSlug: string, mutator: (doc: { getMap(name: string): Map<string, unknown> }) => void): Promise<void>;
  readKv(appSlug: string, key: string): unknown;
  listKv(appSlug: string): Record<string, unknown>;
  getPresence(): Map<string, { status: "online" | "unavailable" | "offline"; last_active_ago: number }>;
}
const BEARER_PREFIX = "Bearer ";

// ── Spec §G explicit power-level map for create_group ────────────────────────
function buildGroupPowerLevels(ownerHandle: string) {
  return {
    users: { [ownerHandle]: 100 },
    users_default: 0,
    state_default: 50,
    events_default: 0,
    events: {
      "m.room.power_levels": 100,
      "m.matrix_os.app_acl": 100,
      "m.matrix_os.app_install": 50,
    },
  };
}

function extractBearer(header: string | undefined): string | null {
  if (!header || !header.startsWith(BEARER_PREFIX)) return null;
  return header.slice(BEARER_PREFIX.length);
}

function makeRequireAuth(expectedToken: string | undefined) {
  return function requireAuth(c: { req: { header: (name: string) => string | undefined } }): boolean {
    const token = extractBearer(c.req.header("Authorization"));
    if (token === null || token.length === 0) return false;
    // If a specific token is configured, validate it; otherwise any non-empty token passes
    // (production uses the gateway's global auth middleware which validates Clerk JWTs)
    if (expectedToken === undefined) return true;
    return token === expectedToken;
  };
}

const CreateGroupBodySchema = z.object({
  name: z.string().min(1),
  member_handles: z.array(z.string()).optional(),
});

const JoinGroupBodySchema = z.object({
  room_id: z.string().min(1),
});

const SAFE_APP_SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;

const ShareAppBodySchema = z.object({
  app_slug: z.string().regex(SAFE_APP_SLUG),
});

export function createGroupRoutes(opts: GroupRoutesOptions) {
  const { matrixClient, groupRegistry } = opts;
  const requireAuth = makeRequireAuth(opts.authToken);
  const app = new Hono();

  // ── POST /api/groups — create a new group ─────────────────────────────────
  app.post(
    "/api/groups",
    bodyLimit({ maxSize: BODY_LIMIT }),
    async (c) => {
      if (!requireAuth(c)) return c.json({ error: "Unauthorized" }, 401);

      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: "Invalid JSON" }, 400);
      }

      const parsed = CreateGroupBodySchema.safeParse(body);
      if (!parsed.success) {
        return c.json({ error: "Invalid request body" }, 400);
      }

      const { name, member_handles = [] } = parsed.data;

      try {
        const { userId: ownerHandle } = await matrixClient.whoami();
        const { roomId } = await matrixClient.createRoom({
          name,
          invite: member_handles,
          preset: "private_chat",
        });

        // Spec §G: MUST call setPowerLevels with the explicit map after createRoom
        await matrixClient.setPowerLevels(roomId, buildGroupPowerLevels(ownerHandle));

        // Write m.matrix_os.group state event
        await matrixClient.setRoomState(roomId, "m.matrix_os.group", "", {
          v: 1,
          schema_version: 1,
          default_acl_policy: "open",
        });

        const manifest = await groupRegistry.create({
          roomId,
          name,
          ownerHandle,
        });

        return c.json({ slug: manifest.slug, room_id: manifest.room_id }, 201);
      } catch {
        return c.json({ error: "Failed to create group" }, 500);
      }
    },
  );

  // ── POST /api/groups/join — accept an invite / join by room_id ────────────
  app.post(
    "/api/groups/join",
    bodyLimit({ maxSize: BODY_LIMIT }),
    async (c) => {
      if (!requireAuth(c)) return c.json({ error: "Unauthorized" }, 401);

      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: "Invalid JSON" }, 400);
      }

      const parsed = JoinGroupBodySchema.safeParse(body);
      if (!parsed.success) {
        return c.json({ error: "Invalid request body" }, 400);
      }

      const { room_id } = parsed.data;

      try {
        const { roomId } = await matrixClient.joinRoom(room_id);
        const { userId: ownerHandle } = await matrixClient.whoami();

        // Fetch room name from state
        let name = roomId;
        try {
          const nameState = await matrixClient.getRoomState(roomId, "m.room.name", "");
          if (nameState && typeof nameState.name === "string") {
            name = nameState.name;
          }
        } catch {
          // best-effort
        }

        const manifest = await groupRegistry.create({
          roomId,
          name,
          ownerHandle,
        });

        return c.json({ slug: manifest.slug, room_id: manifest.room_id }, 200);
      } catch {
        return c.json({ error: "Failed to join group" }, 500);
      }
    },
  );

  // ── GET /api/groups — list all joined groups ──────────────────────────────
  app.get("/api/groups", async (c) => {
    if (!requireAuth(c)) return c.json({ error: "Unauthorized" }, 401);

    const manifests = groupRegistry.list();
    const groups = manifests.map((m) => ({
      slug: m.slug,
      name: m.name,
      room_id: m.room_id,
      owner_handle: m.owner_handle,
      joined_at: m.joined_at,
    }));

    return c.json({ groups }, 200);
  });

  // ── GET /api/groups/:slug — get one group ─────────────────────────────────
  app.get("/api/groups/:slug", async (c) => {
    if (!requireAuth(c)) return c.json({ error: "Unauthorized" }, 401);

    const { slug } = c.req.param();
    const manifest = groupRegistry.get(slug);
    if (!manifest) {
      return c.json({ error: "Group not found" }, 404);
    }

    return c.json({
      slug: manifest.slug,
      name: manifest.name,
      room_id: manifest.room_id,
      owner_handle: manifest.owner_handle,
      joined_at: manifest.joined_at,
    }, 200);
  });

  // ── POST /api/groups/:slug/apps/:app/acl — update per-app ACL ───────────
  app.post(
    "/api/groups/:slug/apps/:app/acl",
    bodyLimit({ maxSize: BODY_LIMIT }),
    async (c) => {
      if (!requireAuth(c)) return c.json({ error: "Unauthorized" }, 401);

      const { slug, app: appSlug } = c.req.param();
      const manifest = groupRegistry.get(slug);
      if (!manifest) return c.json({ error: "Group not found" }, 404);

      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: "Invalid JSON" }, 400);
      }

      const parsed = GroupAclSchema.safeParse(body);
      if (!parsed.success) {
        return c.json({ error: "Invalid ACL" }, 400);
      }

      // Check caller power level ≥ install_pl (spec §H — requires install_pl = 100)
      try {
        const { userId: callerHandle } = await matrixClient.whoami();
        const powerLevels = await matrixClient.getPowerLevels(manifest.room_id);
        const callerPl =
          powerLevels.users?.[callerHandle] ??
          powerLevels.users_default ??
          0;

        if (callerPl < parsed.data.install_pl) {
          return c.json({ error: "Forbidden" }, 403);
        }

        // state_key = appSlug (spec §C / spike §10 typo fix — NOT "")
        await matrixClient.setRoomState(manifest.room_id, "m.matrix_os.app_acl", appSlug, {
          v: 1,
          ...parsed.data,
        });

        return c.json({ ok: true }, 200);
      } catch (err) {
        // Don't expose internal error details
        if ((err as { status?: number }).status === 403) {
          return c.json({ error: "Forbidden" }, 403);
        }
        return c.json({ error: "Failed to update ACL" }, 500);
      }
    },
  );

  // ── POST /api/groups/:slug/share-app — copy app into group ──────────────
  app.post(
    "/api/groups/:slug/share-app",
    bodyLimit({ maxSize: BODY_LIMIT }),
    async (c) => {
      if (!requireAuth(c)) return c.json({ error: "Unauthorized" }, 401);

      const { slug } = c.req.param();
      const manifest = groupRegistry.get(slug);
      if (!manifest) return c.json({ error: "Group not found" }, 404);

      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: "Invalid JSON" }, 400);
      }

      const parsed = ShareAppBodySchema.safeParse(body);
      if (!parsed.success) {
        return c.json({ error: "Invalid request body" }, 400);
      }

      const { app_slug } = parsed.data;

      // Check caller power level ≥ install_pl (100 by default)
      try {
        const { userId: callerHandle } = await matrixClient.whoami();
        const powerLevels = await matrixClient.getPowerLevels(manifest.room_id);
        const callerPl =
          powerLevels.users?.[callerHandle] ??
          powerLevels.users_default ??
          0;

        // install_pl is always 100 for share-app
        if (callerPl < 100) {
          return c.json({ error: "Forbidden" }, 403);
        }
      } catch {
        return c.json({ error: "Forbidden" }, 403);
      }

      const homePath = opts.homePath;
      if (!homePath) {
        return c.json({ error: "Server misconfigured" }, 500);
      }

      const srcPath = resolveWithinHome(homePath, `apps/${app_slug}`);
      if (!srcPath) {
        return c.json({ error: "Invalid app slug" }, 400);
      }

      const destPath = resolveWithinHome(homePath, `groups/${slug}/apps/${app_slug}`);
      if (!destPath) {
        return c.json({ error: "Invalid path" }, 400);
      }

      // Copy app files
      try {
        await cp(srcPath, destPath, { recursive: true });
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
          return c.json({ error: "App not found" }, 404);
        }
        return c.json({ error: "Failed to copy app" }, 500);
      }

      // Write default ACL state event (state_key = app_slug per spike §10)
      try {
        await matrixClient.setRoomState(manifest.room_id, "m.matrix_os.app_acl", app_slug, {
          v: 1,
          read_pl: 0,
          write_pl: 0,
          install_pl: 100,
          policy: "open",
        });

        // Timeline event so members can see a new app was shared
        await matrixClient.sendCustomEvent(manifest.room_id, "m.matrix_os.app_install", {
          app_slug,
        });
      } catch {
        return c.json({ error: "Failed to register app" }, 500);
      }

      return c.json({ slug, app_slug }, 201);
    },
  );

  // ── GET /api/groups/:slug/members — derive members + roles from Matrix ──
  app.get("/api/groups/:slug/members", async (c) => {
    if (!requireAuth(c)) return c.json({ error: "Unauthorized" }, 401);

    const { slug } = c.req.param();
    const manifest = groupRegistry.get(slug);
    if (!manifest) return c.json({ error: "Group not found" }, 404);

    const homePath = opts.homePath;
    const cacheFile = homePath
      ? resolveWithinHome(homePath, `groups/${slug}/members.cache.json`)
      : null;

    try {
      const [rawMembers, powerLevels] = await Promise.all([
        matrixClient.getRoomMembers(manifest.room_id),
        matrixClient.getPowerLevels(manifest.room_id),
      ]);

      const members = rawMembers
        .filter((m) => m.membership === "join" || m.membership === "invite")
        .map((m) => {
          const pl = powerLevels.users?.[m.userId] ?? powerLevels.users_default ?? 0;
          const role = pl >= 75 ? "owner" : pl >= 25 ? "editor" : "viewer";
          return { user_id: m.userId, role, membership: m.membership };
        });

      // Persist cache for offline fallback (best-effort)
      if (cacheFile) {
        const groupDir = resolveWithinHome(homePath!, `groups/${slug}`);
        if (groupDir) {
          await mkdir(groupDir, { recursive: true }).catch(() => {});
          await writeFile(cacheFile, JSON.stringify({ members })).catch(() => {});
        }
      }

      return c.json({ members }, 200);
    } catch {
      // Offline fallback: read members.cache.json
      if (cacheFile) {
        try {
          const raw = await readFile(cacheFile, "utf8");
          const cached = JSON.parse(raw) as { members: unknown[] };
          return c.json({ members: cached.members, from_cache: true }, 200);
        } catch {
          // cache not available
        }
      }
      return c.json({ error: "Members unavailable" }, 503);
    }
  });

  // ── GET /api/groups/:slug/presence — observe-only presence ──────────────
  // No POST route — presence is set by the Matrix protocol, not by clients.
  app.get("/api/groups/:slug/presence", async (c) => {
    if (!requireAuth(c)) return c.json({ error: "Unauthorized" }, 401);

    const { slug } = c.req.param();
    const manifest = groupRegistry.get(slug);
    if (!manifest) return c.json({ error: "Group not found" }, 404);

    const syncHandle = groupRegistry.getSyncHandle(slug) as GroupSyncHandle | null;
    if (!syncHandle) {
      return c.json({ presence: {} }, 200);
    }

    const allPresence = syncHandle.getPresence();

    // Filter to group members only (best-effort — degrade gracefully on Matrix error)
    let memberIds: Set<string>;
    try {
      const rawMembers = await matrixClient.getRoomMembers(manifest.room_id);
      memberIds = new Set(
        rawMembers
          .filter((m) => m.membership === "join" || m.membership === "invite")
          .map((m) => m.userId),
      );
    } catch {
      // If we can't fetch members, return all presence (degrade gracefully)
      memberIds = new Set(allPresence.keys());
    }

    const presence: Record<string, { status: string; last_active_ago: number }> = {};
    for (const [userId, data] of allPresence) {
      if (memberIds.has(userId)) {
        presence[userId] = data;
      }
    }

    return c.json({ presence }, 200);
  });

  // ── POST /api/groups/:slug/data — read/write/list shared KV ─────────────
  app.post(
    "/api/groups/:slug/data",
    bodyLimit({ maxSize: DATA_BODY_LIMIT }),
    async (c) => {
      if (!requireAuth(c)) return c.json({ error: "Unauthorized" }, 401);

      const { slug } = c.req.param();
      const manifest = groupRegistry.get(slug);
      if (!manifest) return c.json({ error: "Group not found" }, 404);

      const syncHandle = groupRegistry.getSyncHandle(slug) as GroupSyncHandle | null;
      if (!syncHandle) return c.json({ error: "Group sync not available" }, 503);

      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: "Invalid JSON" }, 400);
      }

      const parsed = GroupDataRequestSchema.safeParse(body);
      if (!parsed.success) {
        return c.json({ error: "Invalid request" }, 400);
      }

      const { action, app_slug, key, value } = parsed.data;

      try {
        if (action === "write") {
          await syncHandle.applyLocalMutation(app_slug, (doc) => {
            doc.getMap("kv").set(key!, value);
          });
          return c.json({ ok: true }, 200);
        }

        if (action === "read") {
          const val = syncHandle.readKv(app_slug, key!);
          return c.json({ value: val !== undefined ? val : null }, 200);
        }

        // action === "list"
        const entries = syncHandle.listKv(app_slug);
        return c.json({ entries }, 200);
      } catch {
        return c.json({ error: "Data operation failed" }, 500);
      }
    },
  );

  // ── POST /api/groups/:slug/leave — leave and archive a group ─────────────
  app.post("/api/groups/:slug/leave", bodyLimit({ maxSize: 1024 }), async (c) => {
    if (!requireAuth(c)) return c.json({ error: "Unauthorized" }, 401);

    const { slug } = c.req.param();
    const manifest = groupRegistry.get(slug);
    if (!manifest) {
      return c.json({ error: "Group not found" }, 404);
    }

    try {
      await matrixClient.leaveRoom(manifest.room_id);
      await groupRegistry.archive(slug);
      return c.json({ ok: true }, 200);
    } catch {
      return c.json({ error: "Failed to leave group" }, 500);
    }
  });

  return app;
}
