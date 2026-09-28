import { COLLABORATION_RELAY_ACCOUNT_LIMITS } from "@matrix-os/contracts";
import { sql, type Kysely } from "kysely";
import type { CollaborationPlatformDatabase } from "./database.js";
import type { PlatformDB } from "../db.js";

/** Preview access is deliberately excluded: only a live machine owned by this actor counts. */
export async function ownsActiveRelayComputer(db: PlatformDB, actorId: string): Promise<boolean> {
  await db.ready;
  const row = await db.executor.selectFrom("user_machines")
    .select("machine_id")
    .where("clerk_user_id", "=", actorId)
    .where("deleted_at", "is", null)
    .where("status", "in", ["running", "provisioning", "recovering", "resizing", "suspending", "suspended", "resuming"])
    .executeTakeFirst();
  return Boolean(row);
}

export interface RelayAccountLimits { sockets: number; dailyBytes: number }

function boundedInteger(value: string | undefined, fallback: number, min: number, max: number, name: string): number {
  if (value === undefined) return fallback;
  if (!/^[0-9]+$/.test(value)) throw new Error(`Invalid ${name}`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw new Error(`Invalid ${name}`);
  return parsed;
}

/** Invalid overrides fail startup instead of silently weakening the account limit. */
export function loadRelayAccountLimits(env: Record<string, string | undefined>): RelayAccountLimits {
  const defaults = COLLABORATION_RELAY_ACCOUNT_LIMITS;
  return {
    sockets: boundedInteger(env.MATRIX_COLLABORATION_RELAY_MACHINE_FREE_SOCKETS, defaults.sockets,
      defaults.minSockets, defaults.maxSockets, "relay socket limit"),
    dailyBytes: boundedInteger(env.MATRIX_COLLABORATION_RELAY_MACHINE_FREE_DAILY_BYTES, defaults.dailyBytes,
      defaults.minDailyBytes, defaults.maxDailyBytes, "relay daily byte limit"),
  };
}

interface CachedClass { machineFree: boolean; expiresAt: number }

/** Owner-only machine classification. Lookup failure gets the stricter limits. */
export class RelayAccountClassifier {
  private readonly cache = new Map<string, CachedClass>();
  private readonly now: () => number;
  private readonly maxEntries: number;
  private readonly ttlMs: number;

  constructor(private readonly options: {
    ownsActiveComputer(actorId: string): Promise<boolean>;
    now?: () => number;
    maxEntries?: number;
    ttlMs?: number;
  }) {
    this.now = options.now ?? Date.now;
    this.maxEntries = options.maxEntries ?? COLLABORATION_RELAY_ACCOUNT_LIMITS.classifierCacheEntries;
    this.ttlMs = options.ttlMs ?? COLLABORATION_RELAY_ACCOUNT_LIMITS.classifierTtlMs;
    if (!Number.isInteger(this.maxEntries) || this.maxEntries < 1 || this.maxEntries > COLLABORATION_RELAY_ACCOUNT_LIMITS.classifierCacheEntries
      || !Number.isInteger(this.ttlMs) || this.ttlMs < 1 || this.ttlMs > COLLABORATION_RELAY_ACCOUNT_LIMITS.classifierTtlMs) {
      throw new Error("Invalid relay classifier bounds");
    }
  }

  async isMachineFree(actorId: string): Promise<boolean> {
    const now = this.now();
    const cached = this.cache.get(actorId);
    if (cached && cached.expiresAt > now) {
      this.cache.delete(actorId);
      this.cache.set(actorId, cached);
      return cached.machineFree;
    }
    let machineFree: boolean;
    try { machineFree = !(await this.options.ownsActiveComputer(actorId)); }
    catch (error: unknown) {
      console.warn("[collaboration-relay] machine ownership lookup failed", error instanceof Error ? error.name : "UnknownError");
      machineFree = true;
    }
    this.cache.delete(actorId);
    while (this.cache.size >= this.maxEntries) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(actorId, { machineFree, expiresAt: now + this.ttlMs });
    return machineFree;
  }

  cacheSize(): number { return this.cache.size; }
  close(): void { this.cache.clear(); }
}

type UsageDelta = { requests: number; bytes: number; socketOpens: number; refusals: number };
type DailyUsage = { day: string; knownBytes: number; flushingBytes: number; delta: UsageDelta };
type UsageEntry = DailyUsage & { actorId: string; machineFree: boolean; lastTouched: number; activeSockets: number; rollover?: DailyUsage; forwardedTo?: UsageEntry };
const emptyDelta = (): UsageDelta => ({ requests: 0, bytes: 0, socketOpens: 0, refusals: 0 });
const hasDelta = (value: UsageDelta) => value.requests > 0 || value.bytes > 0 || value.socketOpens > 0 || value.refusals > 0;
const busy = (entry: UsageEntry) => hasDelta(entry.delta) || entry.flushingBytes > 0 || entry.activeSockets > 0
  || Boolean(entry.rollover && (hasDelta(entry.rollover.delta) || entry.rollover.flushingBytes > 0));
const dayFor = (now: number) => new Date(now).toISOString().slice(0, 10);
export function relayDailyRetryAfterSeconds(now = Date.now()): number {
  const date = new Date(now);
  const midnight = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1);
  return Math.max(1, Math.ceil((midnight - now) / 1_000));
}
const MAX_PENDING_ACTORS = 16_384;

/** Per-instance additive meter. Database rows contain totals and a coarse account class, never paths or payload. */
export class RelayUsageMeter {
  private readonly pending = new Map<string, UsageEntry>();
  private readonly now: () => number;
  private flushTimer: ReturnType<typeof setInterval> | undefined;
  private pruneTimer: ReturnType<typeof setInterval> | undefined;
  private flushing: Promise<void> | undefined;
  private closed = false;

  constructor(private readonly options: {
    db: Kysely<CollaborationPlatformDatabase>;
    now?: () => number;
    startTimers?: boolean;
  }) {
    this.now = options.now ?? Date.now;
    if (options.startTimers !== false) {
      this.flushTimer = setInterval(() => { void this.flush().catch((error: unknown) => console.warn("[collaboration-relay] usage flush failed", error instanceof Error ? error.name : "UnknownError")); }, 30_000);
      this.pruneTimer = setInterval(() => { void this.prune().catch((error: unknown) => console.warn("[collaboration-relay] usage prune failed", error instanceof Error ? error.name : "UnknownError")); }, 60 * 60_000);
      this.flushTimer.unref?.();
      this.pruneTimer.unref?.();
    }
  }

  async canAdmit(actorId: string, machineFree: boolean, dailyBytes: number): Promise<boolean> {
    if (this.closed) return false;
    const now = this.now();
    const day = dayFor(now);
    let persisted: number;
    try {
      const row = await this.options.db.selectFrom("collaboration_relay_usage_daily")
        .select("bytes").where("actor_id", "=", actorId).where("usage_day", "=", day).executeTakeFirst();
      persisted = Number(row?.bytes ?? 0);
      if (!Number.isSafeInteger(persisted) || persisted < 0) throw new Error("Invalid relay usage total");
    } catch (error: unknown) {
      console.warn("[collaboration-relay] usage admission unavailable", error instanceof Error ? error.name : "UnknownError");
      return !machineFree;
    }
    // The insertion and cap check have no awaits: concurrent local callers cannot exceed the actor registry cap.
    const key = `${actorId}:${day}`;
    let entry = this.pending.get(key);
    if (!entry) {
      if (this.pending.size >= MAX_PENDING_ACTORS) {
        const idle = [...this.pending].find(([, value]) => !busy(value));
        if (idle) this.pending.delete(idle[0]);
      }
      if (this.pending.size >= MAX_PENDING_ACTORS) return !machineFree;
      entry = { actorId, day, machineFree, knownBytes: persisted, flushingBytes: 0, delta: emptyDelta(), lastTouched: now, activeSockets: 0 };
      this.pending.set(key, entry);
    } else {
      entry.machineFree = machineFree;
      if (entry.flushingBytes === 0) entry.knownBytes = Math.max(entry.knownBytes, persisted);
      entry.lastTouched = now;
      this.pending.delete(key);
      this.pending.set(key, entry);
    }
    return !machineFree || Math.max(persisted, entry.knownBytes + entry.flushingBytes) + entry.delta.bytes < dailyBytes;
  }

  /** Returns true only when an open machine-free socket must be closed at the 110% hard stop. */
  record(actorId: string, machineFree: boolean, input: { bytes?: number; requests?: number; socketOpens?: number; refusals?: number }, dailyBytes = COLLABORATION_RELAY_ACCOUNT_LIMITS.dailyBytes, hardStopRatio = 1.1): boolean {
    if (this.closed) return machineFree;
    if (hardStopRatio !== 1 && hardStopRatio !== 1.1) throw new Error("Invalid relay hard-stop ratio");
    const now = this.now();
    const day = dayFor(now);
    const key = `${actorId}:${day}`;
    let entry = this.pending.get(key);
    if (!entry) {
      // A socket can stay open across UTC midnight without another admission call.
      // Start that day's local counter rather than closing it as an unknown actor.
      if (this.pending.size >= MAX_PENDING_ACTORS) {
        const idle = [...this.pending].find(([, value]) => !busy(value));
        if (idle) this.pending.delete(idle[0]);
      }
      if (this.pending.size >= MAX_PENDING_ACTORS) {
        // A socket admitted yesterday must not be mistaken for a quota hard stop
        // at midnight. Carry today's bytes on its existing bounded actor slot.
        const priorDay = dayFor(now - 24 * 60 * 60_000);
        const prior = this.pending.get(`${actorId}:${priorDay}`);
        if (!prior || (prior.rollover && prior.rollover.day !== day)) return false;
        prior.rollover ??= { day, knownBytes: 0, flushingBytes: 0, delta: emptyDelta() };
        entry = prior;
      } else {
        entry = { actorId, day, machineFree, knownBytes: 0, flushingBytes: 0, delta: emptyDelta(), lastTouched: now, activeSockets: 0 };
        this.pending.set(key, entry);
      }
    }
    const target = entry.day === day ? entry : entry.rollover!;
    for (const [field, amount] of Object.entries({ bytes: input.bytes ?? 0, requests: input.requests ?? 0, socketOpens: input.socketOpens ?? 0, refusals: input.refusals ?? 0 })) {
      if (!Number.isSafeInteger(amount) || amount < 0) throw new Error("Invalid relay usage delta");
      target.delta[field as keyof UsageDelta] += amount;
    }
    entry.lastTouched = now;
    return machineFree && target.knownBytes + target.flushingBytes + target.delta.bytes > Math.floor(dailyBytes * hardStopRatio);
  }

  /** Holds a live socket's actor slot across flushes and UTC rollover. */
  retainSocket(actorId: string): () => void {
    const entry = this.pending.get(`${actorId}:${dayFor(this.now())}`);
    if (!entry) return () => undefined;
    entry.activeSockets++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      // A rollover may merge this entry into a separately admitted new-day
      // entry. Follow that move so the live reservation stays protected until close.
      let current = entry;
      while (current.forwardedTo) current = current.forwardedTo;
      current.activeSockets = Math.max(0, current.activeSockets - 1);
    };
  }

  async flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    const snapshot = [...this.pending.values()].flatMap((entry) => {
      const items: Array<{ entry: UsageEntry; target: DailyUsage; day: string; persistedBytes: number; delta: UsageDelta }> = [];
      if (hasDelta(entry.delta)) items.push({ entry, target: entry, day: entry.day, persistedBytes: entry.knownBytes, delta: { ...entry.delta } });
      if (entry.rollover && hasDelta(entry.rollover.delta)) items.push({ entry, target: entry.rollover, day: entry.rollover.day,
        persistedBytes: entry.rollover.knownBytes, delta: { ...entry.rollover.delta } });
      return items;
    });
    if (snapshot.length === 0) return;
    for (const { target, delta } of snapshot) {
      target.flushingBytes += delta.bytes;
      target.delta = emptyDelta();
    }
    this.flushing = this.options.db.transaction().execute(async (trx) => {
      for (const item of snapshot) {
        const { entry, delta } = item;
        const result = await sql<{ bytes: string | number }>`
          INSERT INTO collaboration_relay_usage_daily (actor_id, usage_day, account_class, requests, bytes, socket_opens, refusals)
          VALUES (${entry.actorId}, ${item.day}::date, ${entry.machineFree ? "machine_free" : "computer_owner"},
            ${delta.requests}, ${delta.bytes}, ${delta.socketOpens}, ${delta.refusals})
          ON CONFLICT (actor_id, usage_day) DO UPDATE SET
            account_class = EXCLUDED.account_class,
            requests = collaboration_relay_usage_daily.requests + EXCLUDED.requests,
            bytes = collaboration_relay_usage_daily.bytes + EXCLUDED.bytes,
            socket_opens = collaboration_relay_usage_daily.socket_opens + EXCLUDED.socket_opens,
            refusals = collaboration_relay_usage_daily.refusals + EXCLUDED.refusals
          RETURNING bytes
        `.execute(trx);
        const persisted = Number(result.rows[0]?.bytes);
        if (!Number.isSafeInteger(persisted) || persisted < 0) throw new Error("Invalid relay usage total");
        item.persistedBytes = persisted;
      }
    }).then(() => {
      for (const { target, delta, persistedBytes } of snapshot) {
        target.flushingBytes -= delta.bytes;
        target.knownBytes = Math.max(target.knownBytes, persistedBytes);
      }
      for (const entry of new Set(snapshot.map((item) => item.entry))) {
        if (!entry.rollover || hasDelta(entry.delta) || entry.flushingBytes > 0) continue;
        const next = entry.rollover;
        this.pending.delete(`${entry.actorId}:${entry.day}`);
        const nextKey = `${entry.actorId}:${next.day}`;
        const concurrent = this.pending.get(nextKey);
        if (concurrent && concurrent !== entry) {
          concurrent.activeSockets += entry.activeSockets;
          entry.activeSockets = 0;
          entry.forwardedTo = concurrent;
          concurrent.knownBytes = Math.max(concurrent.knownBytes, next.knownBytes);
          concurrent.delta.requests += next.delta.requests;
          concurrent.delta.bytes += next.delta.bytes;
          concurrent.delta.socketOpens += next.delta.socketOpens;
          concurrent.delta.refusals += next.delta.refusals;
          continue;
        }
        entry.day = next.day;
        entry.knownBytes = next.knownBytes;
        entry.flushingBytes = next.flushingBytes;
        entry.delta = next.delta;
        entry.rollover = undefined;
        this.pending.set(nextKey, entry);
      }
    }).catch((error: unknown) => {
      for (const { target, delta } of snapshot) {
        target.flushingBytes -= delta.bytes;
        target.delta.requests += delta.requests;
        target.delta.bytes += delta.bytes;
        target.delta.socketOpens += delta.socketOpens;
        target.delta.refusals += delta.refusals;
      }
      throw error;
    }).finally(() => { this.flushing = undefined; });
    return this.flushing;
  }

  async prune(now = this.now()): Promise<void> {
    const cutoff = dayFor(now - 35 * 24 * 60 * 60_000);
    await this.options.db.deleteFrom("collaboration_relay_usage_daily").where("usage_day", "<", cutoff).execute();
    for (const [key, entry] of this.pending) if (entry.day < cutoff && !busy(entry)) this.pending.delete(key);
  }

  async close(): Promise<void> {
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    this.flushTimer = undefined;
    this.pruneTimer = undefined;
    if (this.closed) return;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.flush(),
        new Promise<void>((_, reject) => { timeout = setTimeout(() => reject(new Error("Relay usage final flush timed out")), 5_000); }),
      ]);
    } catch (error: unknown) {
      console.warn("[collaboration-relay] final usage flush failed", error instanceof Error ? error.name : "UnknownError");
    } finally {
      if (timeout) clearTimeout(timeout);
      this.closed = true;
      this.pending.clear();
    }
  }
}
