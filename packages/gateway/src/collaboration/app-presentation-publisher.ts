import {
  CollaborativeAppPresentationPublishResponseSchema,
  CollaborativeAppPresentationPublishSchema,
} from "@matrix-os/contracts";
import type { Kysely } from "kysely";
import type { OwnerCollaborationDatabase } from "./database.js";
import type { OwnerAppPresentation, OwnerAppPresentationSource } from "./app-presentation-source.js";
import { requireSecureCollaborationPlatformBaseUrl } from "./platform-base-url.js";

const POLL_INTERVAL_MS = 30_000;
const REQUEST_TIMEOUT_MS = 10_000;
const UPLOAD_TIMEOUT_MS = 30_000;
const MAX_TRACKED_SCOPES = 500;
const RETRY_BASE_MS = 30_000;
const RETRY_MAX_MS = 10 * 60_000;
/** Re-asserts unchanged presentation so platform-side removal (recheck, restore) heals itself. */
const REFRESH_MS = 15 * 60_000;

interface TrackedScope {
  /** What the platform last accepted for this scope; absent until a publication succeeds. */
  fingerprint?: string;
  publishedAt?: number;
  failures: number;
  retryAt: number;
}

/**
 * Publishes the owner's launcher name and artwork for each active app share. It is separate
 * from the directory outbox on purpose: a platform that predates presentation rejects these
 * requests while directory events keep flowing, and the next cycle retries after a backoff.
 */
export class CollaborativeAppPresentationPublisher {
  private readonly origin: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private readonly tracked = new Map<string, TrackedScope>();
  private timer?: ReturnType<typeof setInterval>;
  private active?: Promise<number>;
  private closing = false;

  constructor(private readonly options: {
    db: Kysely<OwnerCollaborationDatabase>;
    ownerId: string;
    runtimeId: string;
    platformBaseUrl: string;
    serviceToken: string;
    source: OwnerAppPresentationSource;
    fetchImpl?: typeof fetch;
    now?: () => Date;
    startTimer?: boolean;
  }) {
    this.origin = requireSecureCollaborationPlatformBaseUrl(options.platformBaseUrl).origin;
    if (Buffer.byteLength(options.serviceToken) < 32) {
      throw new Error("Collaboration presentation service token is unavailable");
    }
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date());
    if (options.startTimer !== false) {
      const tick = () => {
        void this.runOnce().catch((error: unknown) => {
          console.warn("[collaborative-app-presentation] publication cycle failed", error instanceof Error ? error.name : "UnknownError");
        });
      };
      this.timer = setInterval(tick, POLL_INTERVAL_MS);
      this.timer.unref?.();
      queueMicrotask(tick);
    }
  }

  /** Returns how many scopes received a new publication. */
  async runOnce(): Promise<number> {
    if (this.closing) return 0;
    if (this.active) return this.active;
    const active = this.publishChanged();
    this.active = active;
    try {
      return await active;
    } finally {
      if (this.active === active) this.active = undefined;
    }
  }

  async shutdown(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.active) {
      await this.active.catch((error: unknown) => {
        console.warn("[collaborative-app-presentation] final cycle failed", error instanceof Error ? error.name : "UnknownError");
      });
    }
  }

  private async publishChanged(): Promise<number> {
    const shares = await this.options.db.selectFrom("collaboration_app_bindings as binding")
      .innerJoin("collaboration_app_readiness as readiness", "readiness.id", "binding.readiness_id")
      .select(["binding.scope_id", "binding.revision as binding_revision", "readiness.app_id", "readiness.revision as readiness_revision"])
      .where("binding.state", "=", "active")
      .where("readiness.owner_id", "=", this.options.ownerId)
      .orderBy("binding.scope_id")
      .limit(MAX_TRACKED_SCOPES)
      .execute();
    const activeScopes = new Set(shares.map((share) => share.scope_id));
    for (const scopeId of this.tracked.keys()) if (!activeScopes.has(scopeId)) this.tracked.delete(scopeId);
    const nowMs = this.now().getTime();
    const due = shares.filter((share) => (this.tracked.get(share.scope_id)?.retryAt ?? 0) <= nowMs);
    if (due.length === 0) return 0;
    const presentations = await this.options.source.resolve([...new Set(due.map((share) => share.app_id))]);
    let published = 0;
    for (const share of due) {
      if (this.closing) break;
      const presentation = presentations.get(share.app_id);
      if (!presentation) continue;
      // A binding or readiness change (stop/restart, recheck) may have retired the platform copy.
      const fingerprint = JSON.stringify([
        share.app_id, Number(share.binding_revision), Number(share.readiness_revision),
        presentation.name, presentation.artwork?.sha256 ?? null,
      ]);
      const tracked = this.tracked.get(share.scope_id);
      if (tracked?.fingerprint === fingerprint && nowMs - (tracked.publishedAt ?? 0) < REFRESH_MS) continue;
      if (await this.publish(share.scope_id, share.app_id, presentation)) {
        this.tracked.set(share.scope_id, { fingerprint, publishedAt: nowMs, failures: 0, retryAt: 0 });
        published += 1;
      } else {
        const failures = (tracked?.failures ?? 0) + 1;
        this.tracked.set(share.scope_id, {
          ...(tracked?.fingerprint ? { fingerprint: tracked.fingerprint, publishedAt: tracked.publishedAt } : {}),
          failures,
          retryAt: nowMs + Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min(failures - 1, 5)),
        });
      }
    }
    return published;
  }

  private async publish(scopeId: string, appId: string, presentation: OwnerAppPresentation): Promise<boolean> {
    const artwork = presentation.artwork;
    const body = CollaborativeAppPresentationPublishSchema.parse({
      appId,
      name: presentation.name,
      artwork: artwork ? { sha256: artwork.sha256, contentType: artwork.contentType, byteLength: artwork.byteLength } : null,
    });
    const base = `${this.origin}/internal/collaboration/shared-apps/${encodeURIComponent(scopeId)}`;
    try {
      const response = await this.request(`${base}/presentation`, {
        body: JSON.stringify(body), contentType: "application/json", timeoutMs: REQUEST_TIMEOUT_MS,
      });
      if (!response.ok) {
        await response.body?.cancel();
        console.warn("[collaborative-app-presentation] platform rejected presentation", response.status);
        return false;
      }
      const result = CollaborativeAppPresentationPublishResponseSchema.safeParse(await response.json());
      if (!result.success) {
        console.warn("[collaborative-app-presentation] platform response invalid");
        return false;
      }
      if (!result.data.artworkRequired || !artwork) return true;
      const bytes = await this.options.source.readArtwork(artwork);
      // The icon changed after it was described; the next cycle describes and publishes it again.
      if (!bytes) return false;
      const uploaded = await this.request(`${base}/artwork/${artwork.sha256}`, {
        body: bytes, contentType: artwork.contentType, timeoutMs: UPLOAD_TIMEOUT_MS,
      });
      await uploaded.body?.cancel();
      if (!uploaded.ok) console.warn("[collaborative-app-presentation] platform rejected artwork", uploaded.status);
      return uploaded.ok;
    } catch (error: unknown) {
      console.warn("[collaborative-app-presentation] platform unavailable", error instanceof Error ? error.name : "UnknownError");
      return false;
    }
  }

  private request(url: string, input: { body: string | Uint8Array; contentType: string; timeoutMs: number }): Promise<Response> {
    return this.fetchImpl(url, {
      method: "PUT",
      redirect: "error",
      signal: AbortSignal.timeout(input.timeoutMs),
      headers: {
        accept: "application/json",
        authorization: `Bearer ${this.options.serviceToken}`,
        "content-type": input.contentType,
        "x-matrix-runtime-id": this.options.runtimeId,
      },
      body: input.body as BodyInit,
    });
  }
}
