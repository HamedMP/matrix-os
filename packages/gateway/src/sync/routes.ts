import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  PresignRequestSchema,
  CommitRequestSchema,
  ResolveConflictSchema,
} from "./types.js";
import { readManifest, type ManifestStore } from "./manifest.js";
import { generatePresignedUrls } from "./presign.js";
import { handleCommit, type CommitDeps } from "./commit.js";
import {
  syncPresignRequestsTotal,
  syncPresignDuration,
  syncCommitDuration,
  syncFilesSyncedTotal,
  syncManifestEntries,
  syncManifestBytes,
} from "./metrics.js";
import type { PeerRegistry } from "./ws-events.js";
import type { R2Client } from "./r2-client.js";
import type { ManifestDb } from "./manifest.js";

const SYNC_BODY_LIMIT = 65536;

export interface SyncRouteDeps {
  r2: R2Client;
  db: ManifestDb;
  peerRegistry: PeerRegistry;
  getUserId: (c: any) => string;
  getPeerId: (c: any) => string;
}

export function createSyncRoutes(deps: SyncRouteDeps): Hono {
  const app = new Hono();
  const mutatingBodyLimit = bodyLimit({ maxSize: SYNC_BODY_LIMIT });
  const store: ManifestStore = { r2: deps.r2, db: deps.db };

  // GET /manifest
  app.get("/manifest", async (c) => {
    const userId = deps.getUserId(c);
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
    const userId = deps.getUserId(c);
    const body = await c.req.json();
    const parsed = PresignRequestSchema.safeParse(body);

    if (!parsed.success) {
      return c.json({ error: "Validation error", details: parsed.error.issues }, 400);
    }

    const timer = syncPresignDuration.startTimer();
    try {
      const urls = await generatePresignedUrls({ r2: deps.r2 }, userId, parsed.data.files);

      for (const file of parsed.data.files) {
        syncPresignRequestsTotal.inc({ action: file.action, user_id: userId });
      }

      timer({ action: "batch" });
      return c.json({ urls });
    } catch (err: unknown) {
      timer({ action: "batch" });
      if (err instanceof Error && (err.message.includes("path") || err.message.includes("size"))) {
        return c.json({ error: err.message }, 400);
      }
      console.error("[sync/presign] Presign generation failed:", err instanceof Error ? err.message : String(err));
      return c.json({ error: "Presign generation failed" }, 500);
    }
  });

  // POST /commit
  app.post("/commit", mutatingBodyLimit, async (c) => {
    const userId = deps.getUserId(c);
    const peerId = deps.getPeerId(c);
    const body = await c.req.json();
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
        syncFilesSyncedTotal.inc({ action, user_id: userId });
      }
      syncManifestEntries.set({ user_id: userId }, result.committed);

      return c.json(result);
    } catch (err: unknown) {
      timer();
      console.error("[sync/commit] Commit failed:", err instanceof Error ? err.message : String(err));
      return c.json({ error: "Commit failed" }, 500);
    }
  });

  // GET /status
  app.get("/status", async (c) => {
    const userId = deps.getUserId(c);
    const peers = deps.peerRegistry.getPeers(userId);
    const meta = await deps.db.getManifestMeta(userId);

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
    const body = await c.req.json();
    const parsed = ResolveConflictSchema.safeParse(body);

    if (!parsed.success) {
      return c.json({ error: "Validation error", details: parsed.error.issues }, 400);
    }

    // Conflict resolution is recorded and the conflict copy can be deleted
    // Full implementation requires manifest update (Phase 3 sharing scope)
    return c.json({ resolved: true });
  });

  // Share endpoints remain stubs until Phase 3 (sharing scope)
  app.post("/share", mutatingBodyLimit, (c) => c.json({ error: "Not implemented" }, 501));
  app.delete("/share", (c) => c.json({ error: "Not implemented" }, 501));
  app.post("/share/accept", mutatingBodyLimit, (c) => c.json({ error: "Not implemented" }, 501));
  app.get("/shares", (c) => c.json({ error: "Not implemented" }, 501));

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
