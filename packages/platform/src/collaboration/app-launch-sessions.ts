import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import type { CollaborationPlatformDatabase } from "./database.js";
import { CollaborativeAppLaunchRepository, type PersistedAppLaunch } from "./app-launch-repository.js";

const DEFAULT_TTL_MS = 4 * 60_000;
const DEFAULT_SWEEP_MS = 30_000;
const DEFAULT_MAX_SESSIONS = 512;
const DEFAULT_MAX_PER_ACTOR = 8;
const DEFAULT_MAX_RESPONSE_BYTES = 256 * 1024 * 1024;
const ASSET_DOWNLOAD_TIMEOUT_MS = 30_000;
const SAFE_CONTENT_TYPES = new Set([
  "application/json", "application/json; charset=utf-8", "application/octet-stream", "application/wasm",
  "font/woff", "font/woff2", "image/gif", "image/jpeg", "image/png", "image/svg+xml", "image/webp", "image/x-icon",
  "text/css", "text/css; charset=utf-8", "text/html", "text/html; charset=utf-8",
  "text/javascript", "text/javascript; charset=utf-8",
]);

export interface CollaborativeAppLaunchIdentity {
  actorId: string;
  scopeId: string;
  organizationId: string;
  runtimeId: string;
  authorityGeneration: number;
  appId: string;
  catalogId: string;
  buildId: string;
  shareRevision: number;
}

export interface CollaborativeAppLaunchUpstream {
  request(assetPath: string, signal: AbortSignal): Promise<Response>;
  close(): Promise<void> | void;
}

interface LaunchRecord extends CollaborativeAppLaunchIdentity {
  launchId: string;
  clientRequestId: string;
  createdAt: number;
  expiresAt: number;
  lastTouched: number;
  upstream: CollaborativeAppLaunchUpstream;
}

interface PendingLaunch {
  identity: CollaborativeAppLaunchIdentity;
  result: Promise<{ launchId: string; expiresAt: string }>;
}

export class CollaborativeAppLaunchError extends Error {
  constructor(readonly code: "invalid" | "not_found" | "conflict" | "limit" | "host_offline" | "unavailable") {
    super("Collaborative app launch is unavailable");
    this.name = "CollaborativeAppLaunchError";
  }
}

export class CollaborativeAppLaunchSessions {
  private readonly persistence: CollaborativeAppLaunchRepository | undefined;
  private readonly sessions = new Map<string, LaunchRecord>();
  private readonly requests = new Map<string, string>();
  private readonly pending = new Map<string, PendingLaunch>();
  private readonly ttlMs: number;
  private readonly maxSessions: number;
  private readonly maxPerActor: number;
  private readonly maxResponseBytes: number;
  private readonly now: () => number;
  private readonly createId: () => string;
  private readonly timer: ReturnType<typeof setInterval> | undefined;
  private closed = false;
  private closing: Promise<void> | null = null;
  private sweepInFlight: Promise<number> | null = null;

  constructor(private readonly options: {
    db?: Kysely<CollaborationPlatformDatabase>;
    open(identity: CollaborativeAppLaunchIdentity): Promise<CollaborativeAppLaunchUpstream>;
    ttlMs?: number;
    sweepIntervalMs?: number;
    maxSessions?: number;
    maxPerActor?: number;
    maxResponseBytes?: number;
    now?: () => number;
    createId?: () => string;
    startTimer?: boolean;
  }) {
    this.persistence = options.db ? new CollaborativeAppLaunchRepository(options.db) : undefined;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
    this.maxPerActor = options.maxPerActor ?? DEFAULT_MAX_PER_ACTOR;
    this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? randomUUID;
    if (![this.ttlMs, this.maxSessions, this.maxPerActor, this.maxResponseBytes]
      .every((value) => Number.isSafeInteger(value) && value > 0)) throw new CollaborativeAppLaunchError("invalid");
    this.timer = options.startTimer === false ? undefined : setInterval(() => {
      void this.sweep().catch((error: unknown) => {
        console.warn("[collaborative-app-launch] expiry cleanup failed", error instanceof Error ? error.name : "UnknownError");
      });
    }, options.sweepIntervalMs ?? DEFAULT_SWEEP_MS);
    this.timer?.unref?.();
  }

  async create(input: CollaborativeAppLaunchIdentity & { clientRequestId: string }): Promise<{
    launchId: string;
    expiresAt: string;
  }> {
    return this.reserve(input);
  }

  private async reserve(input: CollaborativeAppLaunchIdentity & { clientRequestId: string }, recovery?: PersistedAppLaunch): Promise<{
    launchId: string; expiresAt: string;
  }> {
    if (this.closed) throw new CollaborativeAppLaunchError("unavailable");
    await this.sweep();
    if (this.closed) throw new CollaborativeAppLaunchError("unavailable");
    const requestKey = `${input.actorId}\0${input.clientRequestId}`;
    const cachedId = this.requests.get(requestKey);
    if (this.persistence && cachedId
      && !await this.persistence.get(cachedId, input.scopeId, input.actorId, this.now())) {
      const cached = this.sessions.get(cachedId);
      if (cached) await this.evict(cached);
    }
    const replayId = this.requests.get(requestKey);
    if (replayId) {
      const replay = this.sessions.get(replayId);
      if (!replay || !sameIdentity(replay, input)) throw new CollaborativeAppLaunchError("conflict");
      this.touch(replay);
      return { launchId: replay.launchId, expiresAt: new Date(replay.expiresAt).toISOString() };
    }
    const pending = this.pending.get(requestKey);
    if (pending) {
      if (!sameIdentity(pending.identity, input)) throw new CollaborativeAppLaunchError("conflict");
      return pending.result;
    }
    const pendingForActor = [...this.pending.values()]
      .filter((record) => record.identity.actorId === input.actorId).length;
    const actorSessions = [...this.sessions.values()].filter((record) => record.actorId === input.actorId);
    const draining: Promise<void>[] = [];
    while (actorSessions.length + pendingForActor >= this.maxPerActor) {
      const oldest = actorSessions.shift();
      if (!oldest) throw new CollaborativeAppLaunchError("limit");
      draining.push(this.evict(oldest));
    }
    while (this.sessions.size + this.pending.size >= this.maxSessions) {
      const oldest = this.sessions.values().next().value as LaunchRecord | undefined;
      if (!oldest) throw new CollaborativeAppLaunchError("limit");
      draining.push(this.evict(oldest));
    }
    const result = this.openReserved(input, requestKey, draining, recovery);
    this.pending.set(requestKey, { identity: input, result });
    try {
      return await result;
    } finally {
      if (this.pending.get(requestKey)?.result === result) this.pending.delete(requestKey);
    }
  }

  private async openReserved(
    input: CollaborativeAppLaunchIdentity & { clientRequestId: string },
    requestKey: string,
    draining: Promise<void>[],
    recovery?: PersistedAppLaunch,
  ): Promise<{ launchId: string; expiresAt: string }> {
    await Promise.all(draining);
    if (this.closed) throw new CollaborativeAppLaunchError("unavailable");
    let upstream: CollaborativeAppLaunchUpstream;
    try {
      upstream = await this.options.open(input);
    } catch (error: unknown) {
      if (error instanceof CollaborativeAppLaunchError) throw error;
      console.warn("[collaborative-app-launch] owner session unavailable", error instanceof Error ? error.name : "UnknownError");
      throw new CollaborativeAppLaunchError("host_offline");
    }
    if (this.closed) {
      await this.closeUpstream(upstream);
      throw new CollaborativeAppLaunchError("unavailable");
    }
    const timestamp = this.now();
    let record: LaunchRecord = {
      ...input,
      launchId: recovery?.launchId ?? this.createId(),
      createdAt: recovery?.createdAt ?? timestamp,
      expiresAt: recovery?.expiresAt ?? timestamp + this.ttlMs,
      lastTouched: timestamp,
      upstream,
    };
    if (this.persistence) {
      try {
        // Recovery may only adopt the requested row. Never recreate a revoked,
        // evicted or expired launch after an owner connection finishes opening.
        const persisted = recovery
          ? await this.persistence.get(recovery.launchId, input.scopeId, input.actorId, this.now())
          : await this.persistence.save({
          launchId: record.launchId, clientRequestId: record.clientRequestId, identity: {
            actorId: input.actorId, scopeId: input.scopeId, organizationId: input.organizationId,
            runtimeId: input.runtimeId, authorityGeneration: input.authorityGeneration,
            appId: input.appId, catalogId: input.catalogId, buildId: input.buildId, shareRevision: input.shareRevision,
          }, createdAt: record.createdAt, expiresAt: record.expiresAt,
        }, { maxSessions: this.maxSessions, maxPerActor: this.maxPerActor }, this.now());
        if (!persisted) throw new CollaborativeAppLaunchError("not_found");
        record = { ...record, launchId: persisted.launchId, createdAt: persisted.createdAt, expiresAt: persisted.expiresAt };
      } catch (error: unknown) { await this.closeUpstream(upstream); throw error; }
    }
    if (this.closed) {
      await this.closeUpstream(upstream);
      throw new CollaborativeAppLaunchError("unavailable");
    }
    this.sessions.set(record.launchId, record);
    this.requests.set(requestKey, record.launchId);
    return { launchId: record.launchId, expiresAt: new Date(record.expiresAt).toISOString() };
  }

  describe(launchId: string, actorId: string, scopeId: string): CollaborativeAppLaunchIdentity | null {
    const record = this.sessions.get(launchId);
    if (!record || record.actorId !== actorId || record.scopeId !== scopeId || record.expiresAt <= this.now()) return null;
    return { actorId: record.actorId, scopeId: record.scopeId, organizationId: record.organizationId,
      runtimeId: record.runtimeId, authorityGeneration: record.authorityGeneration, appId: record.appId,
      catalogId: record.catalogId, buildId: record.buildId, shareRevision: record.shareRevision };
  }

  async resolve(launchId: string, actorId: string, scopeId: string): Promise<CollaborativeAppLaunchIdentity | null> {
    if (this.closed) return null;
    return this.persistence
      ? (await this.persistence.get(launchId, scopeId, actorId, this.now()))?.identity ?? null
      : this.describe(launchId, actorId, scopeId);
  }

  async resolveAssetCapability(launchId: string, scopeId: string): Promise<CollaborativeAppLaunchIdentity | null> {
    if (this.closed) return null;
    return this.persistence
      ? (await this.persistence.get(launchId, scopeId, null, this.now()))?.identity ?? null
      : this.describeAssetCapability(launchId, scopeId);
  }

  /** A random launch id is a short-lived capability for immutable module bytes only. */
  describeAssetCapability(launchId: string, scopeId: string): CollaborativeAppLaunchIdentity | null {
    const record = this.sessions.get(launchId);
    if (!record || record.scopeId !== scopeId || record.expiresAt <= this.now()) return null;
    return { actorId: record.actorId, scopeId: record.scopeId, organizationId: record.organizationId,
      runtimeId: record.runtimeId, authorityGeneration: record.authorityGeneration, appId: record.appId,
      catalogId: record.catalogId, buildId: record.buildId, shareRevision: record.shareRevision };
  }

  async request(input: { launchId: string; actorId: string; scopeId: string; assetPath: string; signal?: AbortSignal }): Promise<Response> {
    const segments = input.assetPath.split("/");
    if (input.assetPath.length < 1 || input.assetPath.length > 1_024 || input.assetPath.startsWith("/")
      || input.assetPath.includes("\\") || input.assetPath.includes("\0")
      || segments.some((segment) => !segment || segment === "." || segment === ".." || segment.startsWith("."))) {
      throw new CollaborativeAppLaunchError("invalid");
    }
    if (this.persistence) {
      const persisted = await this.persistence.get(input.launchId, input.scopeId, input.actorId, this.now());
      if (!persisted) throw new CollaborativeAppLaunchError("not_found");
      if (!this.sessions.has(input.launchId)) {
        await this.reserve({ ...persisted.identity, clientRequestId: persisted.clientRequestId }, persisted);
      }
    }
    const record = this.sessions.get(input.launchId);
    if (!record || record.actorId !== input.actorId || record.scopeId !== input.scopeId || record.expiresAt <= this.now()) {
      if (record?.expiresAt && record.expiresAt <= this.now()) await this.evict(record);
      throw new CollaborativeAppLaunchError("not_found");
    }
    this.touch(record);
    let response: Response;
    try {
      const signal = input.signal
        ? AbortSignal.any([input.signal, AbortSignal.timeout(ASSET_DOWNLOAD_TIMEOUT_MS)])
        : AbortSignal.timeout(ASSET_DOWNLOAD_TIMEOUT_MS);
      response = await record.upstream.request(input.assetPath, signal);
    } catch (error: unknown) {
      if (input.signal?.aborted) throw error;
      console.warn("[collaborative-app-launch] owner request unavailable", error instanceof Error ? error.name : "UnknownError");
      throw new CollaborativeAppLaunchError("host_offline");
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new CollaborativeAppLaunchError("unavailable");
    }
    const length = Number(response.headers.get("content-length") ?? -1);
    if (Number.isFinite(length) && length > this.maxResponseBytes) {
      await response.body?.cancel();
      throw new CollaborativeAppLaunchError("unavailable");
    }
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "application/octet-stream";
    if (!SAFE_CONTENT_TYPES.has(contentType)) {
      await response.body?.cancel();
      throw new CollaborativeAppLaunchError("unavailable");
    }
    const headers = new Headers({
      "cache-control": "private, no-store",
      "content-security-policy": "sandbox allow-scripts; base-uri 'none'; object-src 'none'",
      "content-type": contentType,
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    });
    if (length >= 0) headers.set("content-length", String(length));
    return new Response(response.body ? boundedStream(response.body, this.maxResponseBytes) : null, {
      status: response.status,
      headers,
    });
  }

  async revokeScope(scopeId: string): Promise<void> {
    await this.persistence?.revoke(scopeId);
    await Promise.all([...this.sessions.values()].filter((record) => record.scopeId === scopeId).map((record) => this.evict(record)));
  }

  async revokeActor(scopeId: string, actorId: string): Promise<void> {
    await this.persistence?.revoke(scopeId, actorId);
    await Promise.all([...this.sessions.values()]
      .filter((record) => record.scopeId === scopeId && record.actorId === actorId)
      .map((record) => this.evict(record)));
  }

  sweep(): Promise<number> {
    if (this.sweepInFlight) return this.sweepInFlight;
    const pending = this.performSweep().finally(() => {
      if (this.sweepInFlight === pending) this.sweepInFlight = null;
    });
    this.sweepInFlight = pending;
    return pending;
  }

  private async performSweep(): Promise<number> {
    const cutoff = this.now();
    await this.persistence?.sweep(cutoff);
    const expired = [...this.sessions.values()].filter((record) => record.expiresAt <= cutoff);
    await Promise.all(expired.map((record) => this.evict(record)));
    return expired.length;
  }

  async close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.closing = (async () => {
      await Promise.allSettled([
        ...[...this.pending.values()].map((record) => record.result),
        ...(this.sweepInFlight ? [this.sweepInFlight] : []),
      ]);
      await Promise.all([...this.sessions.values()].map((record) => this.evict(record)));
    })();
    return this.closing;
  }

  get size(): number {
    return this.sessions.size;
  }

  private async evict(record: LaunchRecord): Promise<void> {
    if (!this.sessions.delete(record.launchId)) return;
    this.requests.delete(`${record.actorId}\0${record.clientRequestId}`);
    await this.closeUpstream(record.upstream);
  }

  private async closeUpstream(upstream: CollaborativeAppLaunchUpstream): Promise<void> {
    try {
      await upstream.close();
    } catch (error: unknown) {
      console.warn("[collaborative-app-launch] owner session close failed", error instanceof Error ? error.name : "UnknownError");
    }
  }

  private touch(record: LaunchRecord): void {
    record.lastTouched = this.now();
    this.sessions.delete(record.launchId);
    this.sessions.set(record.launchId, record);
  }
}

function sameIdentity(left: CollaborativeAppLaunchIdentity, right: CollaborativeAppLaunchIdentity): boolean {
  return left.scopeId === right.scopeId && left.organizationId === right.organizationId
    && left.runtimeId === right.runtimeId && left.authorityGeneration === right.authorityGeneration
    && left.appId === right.appId && left.catalogId === right.catalogId
    && left.buildId === right.buildId && left.shareRevision === right.shareRevision;
}

function boundedStream(source: ReadableStream<Uint8Array>, maxBytes: number): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let bytes = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) { controller.close(); return; }
        bytes += chunk.value.byteLength;
        if (bytes > maxBytes) {
          await reader.cancel();
          controller.error(new Error("Collaborative app response exceeded safe limits"));
          return;
        }
        controller.enqueue(chunk.value);
      } catch (error: unknown) {
        controller.error(new Error("Collaborative app response unavailable"));
      }
    },
    async cancel(reason) { await reader.cancel(reason); },
  });
}
