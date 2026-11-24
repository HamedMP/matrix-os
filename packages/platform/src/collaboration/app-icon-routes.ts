import type { Context, Hono } from "hono";
import { z } from "zod/v4";
import type { PlatformCollaborationRepository } from "./repository.js";

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const IconQuerySchema = z.object({ v: Sha256Schema.optional() }).strict();
const ICON_READS_PER_MINUTE = 600;
const MAX_TRACKED_KEYS = 10_000;
const INERT_ICON_CSP = "default-src 'none'; sandbox";

/** Read the requested scope's thumbnail after fresh active-share and membership checks. */
export function registerCollaborativeAppIconRoutes(app: Hono, options: {
  repository: Pick<PlatformCollaborationRepository, "getDirectoryRoute" | "getAppThumbnail">;
  resolveActor(c: Context): Promise<string | null>;
  isCurrentOrganizationMember?(input: { organizationId: string; actorId: string }): Promise<boolean>;
  now: () => number;
}): void {
  const reads = new SlidingWindowLimit({ maxKeys: MAX_TRACKED_KEYS, maxAttempts: ICON_READS_PER_MINUTE, windowMs: 60_000, now: options.now });

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
      c.header("Cache-Control", "private, no-cache");
      c.header("CDN-Cache-Control", "no-store");
      c.header("Vary", "Cookie, Authorization");
      c.header("ETag", etag);
      c.header("X-Content-Type-Options", "nosniff");
      c.header("Content-Security-Policy", INERT_ICON_CSP);
      const icon = await options.repository.getAppThumbnail(scopeId.data, route.runtimeId, sha256);
      if (!icon) return safeJson(c, "Collaboration resource not found", 404);
      if (c.req.header("if-none-match") === etag) return c.body(null, 304);
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
