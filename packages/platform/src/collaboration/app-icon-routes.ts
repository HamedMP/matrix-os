import {
  COLLABORATIVE_APP_ICON_MAX_BYTES,
  sniffCollaborativeAppIconContentType,
} from "@matrix-os/contracts";
import { createHash } from "node:crypto";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod/v4";
import { CollaborativeAppIconCapacityError, type CollaborativeAppIconRepository } from "./app-icon-repository.js";
import type { PlatformCollaborationRepository } from "./repository.js";

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const IconQuerySchema = z.object({ v: Sha256Schema.optional() }).strict();
const ICON_UPLOADS_PER_MINUTE = 60;
const ICON_READS_PER_MINUTE = 600;
const MAX_TRACKED_KEYS = 10_000;
const INERT_ICON_CSP = "default-src 'none'; sandbox";

/**
 * ENG-490 shared app icons. The owner runtime pushes raster bytes it already sniffed; the platform
 * re-verifies address and magic bytes, never fetches owner URLs, and serves the bytes only to
 * current organization members of an active current-membership app share.
 */
export function registerCollaborativeAppIconRoutes(app: Hono, options: {
  repository: Pick<PlatformCollaborationRepository, "getDirectoryRoute">;
  icons: CollaborativeAppIconRepository;
  authenticateRuntime(c: Context): Promise<{ runtimeId: string; ownerId: string } | null>;
  resolveActor(c: Context): Promise<string | null>;
  isCurrentOrganizationMember?(input: { organizationId: string; actorId: string }): Promise<boolean>;
  now: () => number;
}): void {
  const uploads = new SlidingWindowLimit({ maxKeys: MAX_TRACKED_KEYS, maxAttempts: ICON_UPLOADS_PER_MINUTE, windowMs: 60_000, now: options.now });
  const reads = new SlidingWindowLimit({ maxKeys: MAX_TRACKED_KEYS, maxAttempts: ICON_READS_PER_MINUTE, windowMs: 60_000, now: options.now });

  app.put(
    "/internal/collaboration/app-icons/:sha256",
    bodyLimit({ maxSize: COLLABORATIVE_APP_ICON_MAX_BYTES, onError: (c) => safeJson(c, "Request too large", 413) }),
    async (c) => {
      const runtime = await options.authenticateRuntime(c);
      if (!runtime) return safeJson(c, "Unauthorized", 401);
      if (!uploads.allow(runtime.runtimeId)) return safeJson(c, "Too many collaboration requests", 429);
      const sha256 = Sha256Schema.safeParse(c.req.param("sha256"));
      if (!sha256.success) return safeJson(c, "Invalid request", 422);
      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(await c.req.arrayBuffer());
      } catch (error: unknown) {
        // A streamed body without Content-Length trips the limit only while it is read.
        if (error instanceof Error && error.name === "BodyLimitError") return safeJson(c, "Request too large", 413);
        console.warn("[platform-collaboration] icon body read failed", error instanceof Error ? error.name : "UnknownError");
        return safeJson(c, "Invalid request", 422);
      }
      const contentType = sniffCollaborativeAppIconContentType(bytes);
      if (!contentType || createHash("sha256").update(bytes).digest("hex") !== sha256.data) {
        return safeJson(c, "Invalid request", 422);
      }
      try {
        await options.icons.put({ runtimeId: runtime.runtimeId, sha256: sha256.data, contentType, bytes });
      } catch (error: unknown) {
        if (error instanceof CollaborativeAppIconCapacityError) return safeJson(c, "Collaboration state changed", 409);
        console.warn("[platform-collaboration] icon upload failed", error instanceof Error ? error.name : "UnknownError");
        return safeJson(c, "Collaboration unavailable", 503);
      }
      // Bounded, best-effort collection of stale unreferenced uploads; never fails the upload.
      await options.icons.collectUnreferenced().catch((error: unknown) => {
        console.warn("[platform-collaboration] icon collection failed", error instanceof Error ? error.name : "UnknownError");
      });
      c.header("Cache-Control", "no-store");
      return c.body(null, 204);
    },
  );

  app.get("/api/collaboration/shared-apps/:scopeId/icon", async (c) => {
    const actorId = await options.resolveActor(c);
    if (!actorId) return safeJson(c, "Unauthorized", 401);
    if (!reads.allow(actorId)) return safeJson(c, "Too many collaboration requests", 429);
    const scopeId = z.uuid().safeParse(c.req.param("scopeId"));
    const query = IconQuerySchema.safeParse(singleValuedQuery(c));
    if (!scopeId.success || !query.success) return safeJson(c, "Invalid request", 422);
    try {
      const route = await options.repository.getDirectoryRoute(scopeId.data);
      if (!route || route.kind !== "app" || route.audience !== "current_membership" || !route.organizationId
        || !route.app || route.app.state !== "active" || !route.app.iconSha256) {
        return safeJson(c, "Collaboration resource not found", 404);
      }
      if (!options.isCurrentOrganizationMember) return safeJson(c, "Collaboration unavailable", 503);
      if (!await options.isCurrentOrganizationMember({ organizationId: route.organizationId, actorId })) {
        return safeJson(c, "Collaboration resource not found", 404);
      }
      const sha256 = route.app.iconSha256;
      const etag = `"${sha256}"`;
      const current = query.data.v === sha256;
      c.header("Cache-Control", current ? "private, max-age=31536000, immutable" : "private, no-cache");
      c.header("ETag", etag);
      c.header("X-Content-Type-Options", "nosniff");
      c.header("Content-Security-Policy", INERT_ICON_CSP);
      if (c.req.header("if-none-match") === etag) return c.body(null, 304);
      const icon = await options.icons.get(route.runtimeId, sha256);
      // Defense in depth: stored bytes are re-sniffed so a bad row can never be served as active content.
      if (!icon || sniffCollaborativeAppIconContentType(icon.bytes) !== icon.contentType) {
        return safeJson(c, "Collaboration resource not found", 404);
      }
      c.header("Content-Type", icon.contentType);
      return c.body(new Uint8Array(icon.bytes), 200);
    } catch (error: unknown) {
      console.warn("[platform-collaboration] icon lookup failed", error instanceof Error ? error.name : "UnknownError");
      return safeJson(c, "Collaboration unavailable", 503);
    }
  });
}

function singleValuedQuery(c: Context): Record<string, string> {
  const parameters = new URL(c.req.url).searchParams;
  const output: Record<string, string> = {};
  for (const key of parameters.keys()) {
    if (key in output) return { duplicate: "true" };
    output[key] = parameters.get(key)!;
  }
  return output;
}

function safeJson(c: Context, error: string, status: 401 | 404 | 409 | 413 | 422 | 429 | 503) {
  c.header("Cache-Control", "no-store");
  return c.json({ error }, status);
}

class SlidingWindowLimit {
  private readonly attempts = new Map<string, number[]>();

  constructor(private readonly options: { maxKeys: number; maxAttempts: number; windowMs: number; now: () => number }) {}

  allow(key: string): boolean {
    const now = this.options.now();
    const cutoff = now - this.options.windowMs;
    const live = (this.attempts.get(key) ?? []).filter((timestamp) => timestamp > cutoff);
    if (live.length >= this.options.maxAttempts) {
      this.attempts.set(key, live);
      return false;
    }
    this.attempts.delete(key);
    // LRU eviction keeps the tracker bounded even under many distinct keys.
    while (this.attempts.size >= this.options.maxKeys) this.attempts.delete(this.attempts.keys().next().value!);
    this.attempts.set(key, [...live, now]);
    return true;
  }
}
