import { createHash } from "node:crypto";
import {
  COLLABORATION_HTTP_BODY_LIMIT,
  COLLABORATIVE_APP_ARTWORK_MAX_BYTES,
  CollaborativeAppArtworkContentTypeSchema,
  CollaborativeAppPresentationPublishResponseSchema,
  CollaborativeAppPresentationPublishSchema,
  collaborativeAppArtworkPath,
  sniffCollaborativeAppArtworkContentType,
  type CollaborativeAppDirectoryPresentation,
} from "@matrix-os/contracts";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod/v4";
import type {
  CollaborativeAppPresentationRepository,
  CollaborativeAppStoredPresentation,
} from "./app-presentation-repository.js";

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
/**
 * Full artwork bytes one member may receive per fixed one-minute window across the whole fleet
 * (the budget lives in Postgres, shared by every worker); revalidations (304) are free.
 */
export const ARTWORK_READ_BYTES_PER_MINUTE = 64 * 1024 * 1024;
const ARTWORK_READ_WINDOW_MS = 60_000;
/** Concurrent cold reads of one digest share a single database read; distinct reads are capped. */
const ARTWORK_MAX_INFLIGHT_READS = 64;
/** Digest-keyed bytes are immutable, so a bounded cache spares repeated database blob reads. */
const ARTWORK_CACHE_MAX_BYTES = 64 * 1024 * 1024;
const ARTWORK_CACHE_MAX_ENTRIES = 256;
// Artwork is replaced only by a new digest URL, so a strong validator needs no extra state.
const ARTWORK_HEADERS = {
  "Cache-Control": "private, no-cache",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'none'; sandbox",
} as const;

/** The launcher field for one listed share; the icon appears only once verified bytes exist. */
export function directoryPresentation(
  scopeId: string,
  stored: CollaborativeAppStoredPresentation | undefined,
): CollaborativeAppDirectoryPresentation | undefined {
  if (!stored) return undefined;
  return {
    name: stored.name,
    ...(stored.artworkSha256 ? { iconUrl: collaborativeAppArtworkPath(scopeId, stored.artworkSha256) } : {}),
  };
}

/**
 * Owner-home publication (runtime-authenticated) and member-gated artwork delivery. Every
 * denial a recipient can observe is the same 404, so artwork reveals nothing about a share.
 */
export function registerSharedAppPresentationRoutes(app: Hono, options: {
  presentations: CollaborativeAppPresentationRepository;
  authenticateRuntime(c: Context): Promise<{ runtimeId: string; ownerId: string } | null>;
  resolveActor(c: Context): Promise<string | null>;
  /** Fresh current-membership admission to an active share, or null. */
  admit(actorId: string, scopeId: string): Promise<unknown>;
  allowArtworkRead(actorId: string): boolean;
  now?: () => number;
}): void {
  const now = options.now ?? (() => Date.now());
  const cache = new ArtworkBytesCache();
  const inflight = new Map<string, Promise<Uint8Array | null>>();

  /** Cache, then one shared in-flight read per digest; null when the stored bytes are gone. */
  function loadArtworkBytes(scopeId: string, sha256: string, byteLength: number): Promise<Uint8Array | null> {
    const key = `${scopeId}:${sha256}`;
    const cached = cache.get(key);
    if (cached) return Promise.resolve(cached);
    const pending = inflight.get(key);
    if (pending) return pending;
    if (inflight.size >= ARTWORK_MAX_INFLIGHT_READS) return Promise.reject(new ArtworkReadsSaturatedError());
    const read = options.presentations.readArtworkBytes(scopeId, sha256).then((stored) => {
      if (!stored || stored.byteLength !== byteLength) return null;
      cache.set(key, stored);
      return stored;
    }).finally(() => inflight.delete(key));
    inflight.set(key, read);
    return read;
  }
  app.put(
    "/internal/collaboration/shared-apps/:scopeId/presentation",
    bodyLimit({ maxSize: COLLABORATION_HTTP_BODY_LIMIT, onError: (c) => safeJson(c, "Request too large", 413) }),
    async (c) => {
      const runtime = await options.authenticateRuntime(c);
      if (!runtime) return safeJson(c, "Unauthorized", 401);
      const scopeId = z.uuid().safeParse(c.req.param("scopeId"));
      const body = CollaborativeAppPresentationPublishSchema.safeParse(await readJson(c));
      if (!scopeId.success || !body.success) return safeJson(c, "Invalid request", 422);
      try {
        const published = await options.presentations.publish({ scopeId: scopeId.data, ...runtime }, body.data);
        if (!published) return safeJson(c, "Collaboration resource not found", 404);
        c.header("Cache-Control", "no-store");
        return c.json(CollaborativeAppPresentationPublishResponseSchema.parse(published));
      } catch (error: unknown) {
        console.warn("[platform-collaboration] app presentation publish failed", error instanceof Error ? error.name : "UnknownError");
        return safeJson(c, "Collaboration unavailable", 503);
      }
    },
  );

  app.put(
    "/internal/collaboration/shared-apps/:scopeId/artwork/:sha256",
    bodyLimit({ maxSize: COLLABORATIVE_APP_ARTWORK_MAX_BYTES, onError: (c) => safeJson(c, "Request too large", 413) }),
    async (c) => {
      const runtime = await options.authenticateRuntime(c);
      if (!runtime) return safeJson(c, "Unauthorized", 401);
      const scopeId = z.uuid().safeParse(c.req.param("scopeId"));
      const sha256 = Sha256Schema.safeParse(c.req.param("sha256"));
      if (!scopeId.success || !sha256.success) return safeJson(c, "Invalid request", 422);
      const contentType = CollaborativeAppArtworkContentTypeSchema.safeParse(c.req.header("content-type")?.toLowerCase());
      if (!contentType.success) return safeJson(c, "Unsupported artwork", 415);
      try {
        const bytes = new Uint8Array(await c.req.arrayBuffer());
        // The digest names the bytes and the bytes name their own type: neither is taken on trust.
        if (bytes.byteLength === 0 || createHash("sha256").update(bytes).digest("hex") !== sha256.data
          || sniffCollaborativeAppArtworkContentType(bytes) !== contentType.data) {
          return safeJson(c, "Artwork does not match its declaration", 409);
        }
        const stored = await options.presentations.storeArtwork(
          { scopeId: scopeId.data, ...runtime },
          { sha256: sha256.data, contentType: contentType.data, bytes },
        );
        if (stored === "not_found") return safeJson(c, "Collaboration resource not found", 404);
        if (stored === "conflict") return safeJson(c, "Artwork does not match its declaration", 409);
        c.header("Cache-Control", "no-store");
        return c.body(null, 204);
      } catch (error: unknown) {
        console.warn("[platform-collaboration] app artwork upload failed", error instanceof Error ? error.name : "UnknownError");
        return safeJson(c, "Collaboration unavailable", 503);
      }
    },
  );

  app.get("/api/collaboration/shared-apps/:scopeId/artwork/:sha256", async (c) => {
    const actorId = await options.resolveActor(c);
    if (!actorId) return safeJson(c, "Unauthorized", 401);
    if (!options.allowArtworkRead(actorId)) return safeJson(c, "Too many collaboration requests", 429);
    const scopeId = z.uuid().safeParse(c.req.param("scopeId"));
    const sha256 = Sha256Schema.safeParse(c.req.param("sha256"));
    if (!scopeId.success || !sha256.success) return safeJson(c, "Invalid request", 422);
    try {
      // Membership, the active share, and the current digest are checked on every view, before
      // any image bytes are read; a revalidation never loads the image at all.
      if (!await options.admit(actorId, scopeId.data)) return safeJson(c, "Collaboration resource not found", 404);
      const artwork = await options.presentations.describeArtwork(scopeId.data, sha256.data);
      if (!artwork) return safeJson(c, "Collaboration resource not found", 404);
      const etag = `"${sha256.data}"`;
      if (c.req.header("if-none-match")?.split(",").some((candidate) => candidate.trim() === etag)) {
        for (const [name, value] of Object.entries(ARTWORK_HEADERS)) c.header(name, value);
        c.header("ETag", etag);
        return c.body(null, 304);
      }
      const reserved = await options.presentations.reserveArtworkReadBytes({
        actorId, bytes: artwork.byteLength, limit: ARTWORK_READ_BYTES_PER_MINUTE, windowMs: ARTWORK_READ_WINDOW_MS, now: now(),
      });
      if (!reserved) return safeJson(c, "Too many collaboration requests", 429);
      const bytes = await loadArtworkBytes(scopeId.data, sha256.data, artwork.byteLength);
      if (!bytes) return safeJson(c, "Collaboration resource not found", 404);
      for (const [name, value] of Object.entries(ARTWORK_HEADERS)) c.header(name, value);
      c.header("ETag", etag);
      c.header("Content-Type", artwork.contentType);
      c.header("Content-Length", String(bytes.byteLength));
      return c.body(bytes as Uint8Array<ArrayBuffer>, 200);
    } catch (error: unknown) {
      console.warn("[platform-collaboration] app artwork read failed", error instanceof Error ? error.name : "UnknownError");
      return safeJson(c, "Collaboration unavailable", 503);
    }
  });
}

class ArtworkReadsSaturatedError extends Error {
  constructor() {
    super("Too many concurrent artwork reads");
    this.name = "ArtworkReadsSaturatedError";
  }
}

/** LRU of immutable digest-keyed artwork, bounded in total bytes and entries. */
class ArtworkBytesCache {
  private readonly entries = new Map<string, Uint8Array>();
  private bytes = 0;

  get(key: string): Uint8Array | undefined {
    const value = this.entries.get(key);
    if (!value) return undefined;
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  set(key: string, value: Uint8Array): void {
    if (value.byteLength > ARTWORK_CACHE_MAX_BYTES) return;
    const previous = this.entries.get(key);
    if (previous) {
      this.entries.delete(key);
      this.bytes -= previous.byteLength;
    }
    while (this.entries.size > 0
      && (this.bytes + value.byteLength > ARTWORK_CACHE_MAX_BYTES || this.entries.size >= ARTWORK_CACHE_MAX_ENTRIES)) {
      const [oldestKey, oldest] = this.entries.entries().next().value!;
      this.entries.delete(oldestKey);
      this.bytes -= oldest.byteLength;
    }
    this.entries.set(key, value);
    this.bytes += value.byteLength;
  }
}

async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch (error: unknown) {
    if (!(error instanceof SyntaxError)) {
      console.warn("[platform-collaboration] app presentation body unreadable", error instanceof Error ? error.name : "UnknownError");
    }
    return undefined;
  }
}

function safeJson(c: Context, error: string, status: 401 | 404 | 409 | 413 | 415 | 422 | 429 | 503) {
  c.header("Cache-Control", "no-store");
  return c.json({ error }, status);
}
