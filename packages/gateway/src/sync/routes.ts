import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import {
  PresignRequestSchema,
  CommitRequestSchema,
  ResolveConflictSchema,
  CreateShareSchema,
  AcceptShareSchema,
  DeleteShareSchema,
} from "./types.js";
import { readManifest, type ManifestStore } from "./manifest.js";
import {
  generatePresignedUrls,
  PresignValidationError,
} from "./presign.js";
import { handleCommit, type CommitDeps } from "./commit.js";
import { resolveWithinPrefix } from "./path-validation.js";
import {
  syncPresignRequestsTotal,
  syncPresignDuration,
  syncCommitDuration,
  syncFilesSyncedTotal,
  syncConnectedPeers,
  syncManifestBytes,
  syncManifestEntries,
} from "./metrics.js";
import type { PeerRegistry } from "./ws-events.js";
import type { R2Client } from "./r2-client.js";
import type { ManifestDb } from "./manifest.js";
import {
  type SharingService,
  ShareNotFoundError,
  ShareSelfError,
  ShareDuplicateError,
  ShareForbiddenError,
  GranteeNotFoundError,
  ShareInvalidPathError,
} from "./sharing.js";
import { createSyncRateLimiter } from "./rate-limiter.js";
import { MissingSyncUserIdentityError } from "../auth.js";

const SYNC_BODY_LIMIT = 65536;

export interface SyncRouteDeps {
  r2: R2Client;
  db: ManifestDb;
  peerRegistry: PeerRegistry;
  sharing: SharingService;
  getUserId: (c: any) => string;
  getPeerId: (c: any) => string;
}

export function createSyncRoutes(deps: SyncRouteDeps): Hono {
  const app = new Hono();
  const mutatingBodyLimit = bodyLimit({ maxSize: SYNC_BODY_LIMIT });
  const store: ManifestStore = { r2: deps.r2, db: deps.db };
  const presignLimiter = createSyncRateLimiter({ maxRequests: 100, windowMs: 60_000 });
  const commitLimiter = createSyncRateLimiter({ maxRequests: 100, windowMs: 60_000 });
  const shareLimiter = createSyncRateLimiter({ maxRequests: 60, windowMs: 60_000 });
  // Shared-folder data-plane access remains intentionally fail-closed in this
  // PR. Share CRUD/list endpoints ship here, but presign/commit still operate
  // only on the caller's own namespace until shared-folder daemon plumbing and
  // owner-scoped JWTs land (tracked in specs/066-file-sync/follow-ups.md).
  const getUserId = (c: Parameters<SyncRouteDeps["getUserId"]>[0]): string => {
    try {
      return deps.getUserId(c);
    } catch (err) {
      if (err instanceof MissingSyncUserIdentityError) {
        throw new HTTPException(401, { message: "Unauthorized" });
      }
      throw err;
    }
  };

  async function parseJsonBody(c: { req: { json: () => Promise<unknown> } }) {
    try {
      return { ok: true as const, body: await c.req.json() };
    } catch (err: unknown) {
      if (err instanceof SyntaxError) {
        return { ok: false as const };
      }
      throw err;
    }
  }

  // GET /manifest
  app.get("/manifest", async (c) => {
    const userId = getUserId(c);
    const ifNoneMatch = c.req.header("If-None-Match");

    const result = await readManifest(store, userId);

    if (ifNoneMatch && ifNoneMatch === result.etag) {
      return c.body(null, 304);
    }

    c.header("ETag", result.etag);
    return c.json({
      manifest: result.manifest,
      manifestVersion: result.manifestVersion,
      etag: result.etag,
    });
  });

  // POST /presign
  app.post("/presign", mutatingBodyLimit, async (c) => {
    const userId = getUserId(c);

    if (!presignLimiter.check(userId)) {
      return c.json({ error: "Rate limit exceeded" }, 429);
    }

    const json = await parseJsonBody(c);
    if (!json.ok) {
      return c.json({ error: "Invalid JSON" }, 400);
    }
    const body = json.body;
    const parsed = PresignRequestSchema.safeParse(body);

    if (!parsed.success) {
      return c.json({ error: "Validation error", details: parsed.error.issues }, 400);
    }

    const timer = syncPresignDuration.startTimer();
    try {
      const urls = await generatePresignedUrls({ r2: deps.r2 }, userId, parsed.data.files);

      for (const file of parsed.data.files) {
        syncPresignRequestsTotal.inc({ action: file.action });
      }

      timer({ action: "batch" });
      return c.json({ urls });
    } catch (err: unknown) {
      timer({ action: "batch" });
      const isValidationErr = err instanceof PresignValidationError;
      console.error(
        "[sync/presign] Presign generation failed:",
        err instanceof Error ? err.message : String(err),
      );
      return c.json(
        { error: isValidationErr ? "Invalid request" : "Presign generation failed" },
        isValidationErr ? 400 : 500,
      );
    }
  });

  // POST /commit
  app.post("/commit", mutatingBodyLimit, async (c) => {
    const userId = getUserId(c);
    const peerId = deps.getPeerId(c);
    if (!commitLimiter.check(userId)) {
      return c.json({ error: "Rate limit exceeded" }, 429);
    }
    const json = await parseJsonBody(c);
    if (!json.ok) {
      return c.json({ error: "Invalid JSON" }, 400);
    }
    const body = json.body;
    const parsed = CommitRequestSchema.safeParse(body);

    if (!parsed.success) {
      return c.json({ error: "Validation error", details: parsed.error.issues }, 400);
    }

    const timer = syncCommitDuration.startTimer();
    try {
      const commitDeps: CommitDeps = {
        r2: deps.r2,
        db: deps.db,
        broadcast: (uid, sender, msg) => deps.peerRegistry.broadcastChange(uid, sender, msg),
      };

      const result = await handleCommit(commitDeps, userId, peerId, parsed.data);

      timer();

      if ("error" in result) {
        if (result.error === "version_conflict") {
          return c.json(result, 409);
        }
        return c.json({ error: result.error }, 400);
      }

      // Update metrics
      for (const file of parsed.data.files) {
        const action = file.action ?? "update";
        syncFilesSyncedTotal.inc({ action });
      }

      return c.json(result);
    } catch (err: unknown) {
      timer();
      console.error("[sync/commit] Commit failed:", err instanceof Error ? err.message : String(err));
      return c.json({ error: "Commit failed" }, 500);
    }
  });

  // GET /status
  app.get("/status", async (c) => {
    const userId = getUserId(c);
    const peers = deps.peerRegistry.getPeers(userId);
    const meta = await deps.db.getManifestMeta(userId);
    const aggregate = await deps.db.getAggregateManifestStats?.();

    syncConnectedPeers.set(deps.peerRegistry.getTotalPeerCount());
    syncManifestEntries.set(aggregate?.fileCount ?? 0);
    syncManifestBytes.set(Number(aggregate?.totalSize ?? 0n));

    return c.json({
      connectedPeers: peers.map((p) => ({
        peerId: p.peerId,
        hostname: p.hostname,
        platform: p.platform,
        connectedAt: p.connectedAt,
      })),
      manifestVersion: meta?.version ?? 0,
      fileCount: meta?.file_count ?? 0,
      totalSize: Number(meta?.total_size ?? 0),
      lastSyncAt: meta?.updated_at?.getTime() ?? 0,
      pendingConflicts: 0,
    });
  });

  // POST /resolve-conflict
  app.post("/resolve-conflict", mutatingBodyLimit, async (c) => {
    const userId = getUserId(c);
    if (!commitLimiter.check(userId)) {
      return c.json({ error: "Rate limit exceeded" }, 429);
    }
    const json = await parseJsonBody(c);
    if (!json.ok) {
      return c.json({ error: "Invalid JSON" }, 400);
    }
    const body = json.body;
    const parsed = ResolveConflictSchema.safeParse(body);

    if (!parsed.success) {
      return c.json({ error: "Validation error", details: parsed.error.issues }, 400);
    }

    const requestedPath = resolveWithinPrefix(userId, parsed.data.path);
    if (!requestedPath.valid) {
      return c.json({ error: "Invalid path" }, 400);
    }

    if (parsed.data.conflictPath) {
      const pathCheck = resolveWithinPrefix(userId, parsed.data.conflictPath);
      if (!pathCheck.valid) {
        return c.json({ error: "Invalid conflict path" }, 400);
      }
      try {
        await deps.r2.deleteObject(pathCheck.key);
      } catch (err: unknown) {
        console.error("[sync/resolve-conflict] Failed to delete conflict copy:", err instanceof Error ? err.message : String(err));
        return c.json({ error: "Failed to delete conflict copy" }, 500);
      }
    }

    return c.json({ resolved: true });
  });

  // -----------------------------------------------------------------------
  // Sharing endpoints
  // -----------------------------------------------------------------------

  // POST /share -- create sharing grant
  app.post("/share", mutatingBodyLimit, async (c) => {
    const userId = getUserId(c);
    if (!shareLimiter.check(userId)) {
      return c.json({ error: "Rate limit exceeded" }, 429);
    }
    const json = await parseJsonBody(c);
    if (!json.ok) {
      return c.json({ error: "Invalid JSON" }, 400);
    }
    const body = json.body;
    const parsed = CreateShareSchema.safeParse(body);

    if (!parsed.success) {
      return c.json({ error: "Validation error", details: parsed.error.issues }, 400);
    }

    try {
      const result = await deps.sharing.createShare(userId, parsed.data);
      return c.json(result, 201);
    } catch (err: unknown) {
      if (err instanceof GranteeNotFoundError) {
        return c.json({ error: "Grantee not found" }, 404);
      }
      if (err instanceof ShareSelfError) {
        return c.json({ error: err.message }, 400);
      }
      if (err instanceof ShareInvalidPathError) {
        return c.json({ error: err.message }, 400);
      }
      if (err instanceof ShareDuplicateError) {
        return c.json({ error: err.message }, 409);
      }
      console.error("[sync/share] Create share failed:", err instanceof Error ? err.message : String(err));
      return c.json({ error: "Share creation failed" }, 500);
    }
  });

  // DELETE /share -- revoke sharing grant
  app.delete("/share", mutatingBodyLimit, async (c) => {
    const userId = getUserId(c);
    if (!shareLimiter.check(userId)) {
      return c.json({ error: "Rate limit exceeded" }, 429);
    }
    const json = await parseJsonBody(c);
    if (!json.ok) {
      return c.json({ error: "Invalid JSON" }, 400);
    }
    const parsed = DeleteShareSchema.safeParse(json.body);
    if (!parsed.success) {
      return c.json({ error: "Validation error", details: parsed.error.issues }, 400);
    }
    const { shareId } = parsed.data;

    try {
      await deps.sharing.revokeShare(userId, shareId);
      return c.json({ revoked: true });
    } catch (err: unknown) {
      if (err instanceof ShareNotFoundError) {
        return c.json({ error: err.message }, 404);
      }
      if (err instanceof ShareForbiddenError) {
        return c.json({ error: err.message }, 403);
      }
      console.error("[sync/share] Revoke share failed:", err instanceof Error ? err.message : String(err));
      return c.json({ error: "Share revocation failed" }, 500);
    }
  });

  // POST /share/accept -- accept share invitation
  app.post("/share/accept", mutatingBodyLimit, async (c) => {
    const userId = getUserId(c);
    if (!shareLimiter.check(userId)) {
      return c.json({ error: "Rate limit exceeded" }, 429);
    }
    const json = await parseJsonBody(c);
    if (!json.ok) {
      return c.json({ error: "Invalid JSON" }, 400);
    }
    const body = json.body;
    const parsed = AcceptShareSchema.safeParse(body);

    if (!parsed.success) {
      return c.json({ error: "Validation error", details: parsed.error.issues }, 400);
    }

    try {
      const result = await deps.sharing.acceptShare(userId, parsed.data.shareId);
      return c.json(result);
    } catch (err: unknown) {
      if (err instanceof ShareNotFoundError) {
        return c.json({ error: err.message }, 404);
      }
      if (err instanceof ShareForbiddenError) {
        return c.json({ error: err.message }, 403);
      }
      console.error("[sync/share] Accept share failed:", err instanceof Error ? err.message : String(err));
      return c.json({ error: "Share acceptance failed" }, 500);
    }
  });

  // GET /shares -- list active shares
  app.get("/shares", async (c) => {
    const userId = getUserId(c);

    try {
      const result = await deps.sharing.listShares(userId);
      return c.json(result);
    } catch (err: unknown) {
      console.error("[sync/shares] List shares failed:", err instanceof Error ? err.message : String(err));
      return c.json({ error: "Failed to list shares" }, 500);
    }
  });

  return app;
}

// Backward-compatible stub for server.ts until deps are wired
const syncApp = new Hono();
syncApp.get("/manifest", (c) => c.json({ error: "Not configured" }, 503));
syncApp.post("/presign", (c) => c.json({ error: "Not configured" }, 503));
syncApp.post("/commit", (c) => c.json({ error: "Not configured" }, 503));
syncApp.get("/status", (c) => c.json({ error: "Not configured" }, 503));
syncApp.post("/resolve-conflict", (c) => c.json({ error: "Not configured" }, 503));
syncApp.post("/share", (c) => c.json({ error: "Not configured" }, 503));
syncApp.delete("/share", (c) => c.json({ error: "Not configured" }, 503));
syncApp.post("/share/accept", (c) => c.json({ error: "Not configured" }, 503));
syncApp.get("/shares", (c) => c.json({ error: "Not configured" }, 503));

export { syncApp };
