import { setTimeout as delay } from "node:timers/promises";
import { sql, type Kysely } from "kysely";
import {
  MESSAGING_BRIDGE_CHANGED_EVENT,
  MatrixRoomIdSchema,
  type MessagingBridgeChangedEvent,
  type MessagingBridgeNetwork,
  type MessagingBridgeSession,
} from "@matrix-os/contracts/messaging-bridge";
import { errorName } from "./bridge-http.js";
import { MatrixRequestError, MATRIX_SYNC_LONG_POLL_MS, type BridgeMatrixClient, type MatrixSyncResponse } from "./bridge-matrix-client.js";
import {
  classifyTimelineEvent,
  detectBridgeNetwork,
  isBridgeNamespaceUser,
  memberDisplayNames,
  roomDisplayName,
  serverNameOf,
  type MatrixClientEvent,
} from "./bridge-room-state.js";
import type { BridgeSessionProvider } from "./bridge-session.js";
import {
  BridgeSyncPositionConflictError,
  type BridgeAccountRow,
  type BridgeConversationUpsert,
  type BridgeMessageInsert,
  type KnownBridgeRoom,
  type MessagingBridgeDatabase,
  type MessagingBridgeStore,
} from "./bridge-store.js";

export const SYNC_BACKOFF_MIN_MS = 1_000;
export const SYNC_BACKOFF_MAX_MS = 60_000;
export const SYNC_LOCK_RETRY_MS = 30_000;
const IGNORED_ROOM_CAP = 256;

/* ------------------------------------------------------------------ */
/* Single-sync guarantee                                               */
/* ------------------------------------------------------------------ */

export interface BridgeSyncLockHandle {
  /** Aborted when the lock holder's connection is lost. */
  readonly lost: AbortSignal;
  release(): Promise<void>;
}

export interface BridgeSyncLock {
  tryAcquire(ownerId: string): Promise<BridgeSyncLockHandle | null>;
}

/**
 * Session-level Postgres advisory lock held on one pinned connection for the
 * lifetime of the sync loop, so two gateway processes never both sync.
 */
export function createPostgresAdvisoryLock(kysely: Kysely<MessagingBridgeDatabase>): BridgeSyncLock {
  return {
    async tryAcquire(ownerId) {
      const key = `matrix-os:messaging-bridge-sync:${ownerId}`;
      const lost = new AbortController();
      let releaseHold!: () => void;
      const hold = new Promise<void>((resolve) => { releaseHold = resolve; });
      let reportAcquired!: (locked: boolean) => void;
      const acquired = new Promise<boolean>((resolve) => { reportAcquired = resolve; });
      const holder = kysely.connection().execute(async (connection) => {
        const result = await sql<{ locked: boolean }>`SELECT pg_try_advisory_lock(hashtextextended(${key}, 0)) AS locked`.execute(connection);
        const locked = result.rows[0]?.locked === true;
        reportAcquired(locked);
        if (!locked) return;
        try {
          await hold;
        } finally {
          await sql`SELECT pg_advisory_unlock(hashtextextended(${key}, 0))`.execute(connection);
        }
      }).catch((err: unknown) => {
        console.warn("[messages/bridge-sync] advisory lock connection failed", errorName(err));
        reportAcquired(false);
        lost.abort();
      });
      if (!await acquired) {
        await holder;
        return null;
      }
      return {
        lost: lost.signal,
        async release() {
          releaseHold();
          await holder;
        },
      };
    },
  };
}

/* ------------------------------------------------------------------ */
/* Sync service                                                        */
/* ------------------------------------------------------------------ */

export type BridgeSyncHealth = "idle" | "ok" | "unavailable";

export interface BridgeSyncService {
  /** Starts the loop if it is not running. Idempotent. */
  ensureRunning(): void;
  /** Aborts the in-flight request and waits for the loop to exit. */
  stop(): Promise<void>;
  /** One fetch-and-apply cycle; the loop's unit of work. */
  syncOnce(signal?: AbortSignal): Promise<void>;
  running(): boolean;
  health(): BridgeSyncHealth;
}

export interface BridgeSyncServiceOptions {
  ownerId: string;
  store: MessagingBridgeStore;
  sessions: BridgeSessionProvider;
  matrix: BridgeMatrixClient;
  lock: BridgeSyncLock;
  onChanged(event: MessagingBridgeChangedEvent): void;
  random?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  longPollMs?: number;
  lockRetryMs?: number;
}

export function syncBackoffMs(failures: number, random: () => number): number {
  const base = Math.min(SYNC_BACKOFF_MAX_MS, SYNC_BACKOFF_MIN_MS * 2 ** Math.max(0, failures - 1));
  return Math.min(SYNC_BACKOFF_MAX_MS, Math.round(base * (1 + random())));
}

async function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  try {
    await delay(ms, undefined, { signal });
  } catch (err: unknown) {
    if (!(err instanceof Error && err.name === "AbortError")) throw err;
  }
}

function pickAccount(accounts: BridgeAccountRow[], network: MessagingBridgeNetwork, receiver?: string): string | null {
  const forNetwork = accounts.filter((account) => account.network === network);
  return (receiver ? forNetwork.find((account) => account.loginId === receiver) : undefined)?.id ?? forNetwork[0]?.id ?? null;
}

function inviterOf(events: MatrixClientEvent[], ownUserId: string): string | null {
  const invite = events.find((event) => event.type === "m.room.member" && event.state_key === ownUserId
    && event.content?.membership === "invite");
  return typeof invite?.sender === "string" ? invite.sender : null;
}

export function createBridgeSyncService(options: BridgeSyncServiceOptions): BridgeSyncService {
  const random = options.random ?? Math.random;
  const sleep = options.sleep ?? abortableSleep;
  const longPollMs = options.longPollMs ?? MATRIX_SYNC_LONG_POLL_MS;
  const lockRetryMs = options.lockRetryMs ?? SYNC_LOCK_RETRY_MS;
  // Rooms confirmed not to be portals (bridge bot management rooms); capped, oldest evicted.
  const ignoredRooms = new Set<string>();
  let controller: AbortController | null = null;
  let loop: Promise<void> | null = null;
  let health: BridgeSyncHealth = "idle";

  function rememberIgnored(roomId: string): void {
    ignoredRooms.delete(roomId);
    ignoredRooms.add(roomId);
    while (ignoredRooms.size > IGNORED_ROOM_CAP) {
      const oldest = ignoredRooms.values().next().value;
      if (oldest === undefined) break;
      ignoredRooms.delete(oldest);
    }
  }

  async function acceptInvites(session: MessagingBridgeSession, response: MatrixSyncResponse, signal?: AbortSignal): Promise<void> {
    const serverName = serverNameOf(session.userId);
    if (!serverName) return;
    for (const [roomId, invite] of Object.entries(response.rooms?.invite ?? {})) {
      if (!MatrixRoomIdSchema.safeParse(roomId).success) continue;
      const inviter = inviterOf(invite.invite_state?.events ?? [], session.userId);
      if (!inviter || !isBridgeNamespaceUser(inviter, serverName)) continue;
      try {
        await options.sessions.withSession((current) => options.matrix.joinRoom(current, roomId, signal));
      } catch (err: unknown) {
        // A permanently refused invite must not wedge the loop; transient failures retry the batch.
        if (err instanceof MatrixRequestError && !err.retryable) {
          console.warn("[messages/bridge-sync] invite refused by homeserver", err.status);
          continue;
        }
        throw err;
      }
    }
  }

  async function syncOnce(signal?: AbortSignal): Promise<void> {
    const since = await options.store.getSyncPosition(options.ownerId);
    const response = await options.sessions.withSession((session) => options.matrix.sync(session, {
      ...(since ? { since } : {}),
      timeoutMs: since ? longPollMs : 0,
      ...(signal ? { signal } : {}),
    }));
    const session = await options.sessions.current();
    await acceptInvites(session, response, signal);

    const joined = Object.entries(response.rooms?.join ?? {})
      .filter(([roomId]) => MatrixRoomIdSchema.safeParse(roomId).success);
    const known = await options.store.getKnownRooms(options.ownerId, joined.map(([roomId]) => roomId));
    const accounts = await options.store.listBridgeAccounts(options.ownerId);
    const conversations: BridgeConversationUpsert[] = [];
    const messages: BridgeMessageInsert[] = [];

    for (const [roomId, room] of joined) {
      const timeline = room.timeline?.events ?? [];
      let stateEvents: MatrixClientEvent[] = [...(room.state?.events ?? []), ...timeline.filter((event) => typeof event.state_key === "string")];
      const classified = timeline.flatMap((event) => {
        const result = classifyTimelineEvent(event, session.userId);
        return result ? [result] : [];
      });
      const existing: KnownBridgeRoom | undefined = known.get(roomId);
      let detected = detectBridgeNetwork(stateEvents);
      if (!detected && !existing) {
        if (ignoredRooms.has(roomId) || classified.length === 0) continue;
        stateEvents = await options.sessions.withSession((current) => options.matrix.getRoomState(current, roomId, signal));
        detected = detectBridgeNetwork(stateEvents);
        if (!detected) {
          rememberIgnored(roomId);
          continue;
        }
      }
      const network = detected?.network ?? existing!.network;
      const accountId = pickAccount(accounts, network, detected?.receiver) ?? existing?.accountId;
      if (!accountId) continue;
      const renamed = stateEvents.some((event) => event.type === "m.room.name");
      const displayName = !existing || renamed ? roomDisplayName(stateEvents, session.userId) : existing.displayName;
      if (!existing || existing.network !== network || existing.accountId !== accountId || existing.displayName !== displayName) {
        conversations.push({ roomId, network, accountId, displayName });
      }
      const names = memberDisplayNames(stateEvents);
      for (const event of classified) {
        messages.push({
          roomId,
          eventId: event.eventId,
          direction: event.direction,
          senderName: event.direction === "outgoing" ? "You" : names.get(event.sender) ?? displayName,
          kind: event.kind,
          body: event.body,
          occurredAt: event.occurredAt,
          ...(event.transactionId ? { transactionId: event.transactionId } : {}),
        });
      }
    }

    const result = await options.store.applySyncBatch({
      ownerId: options.ownerId,
      previousBatch: since,
      nextBatch: response.next_batch,
      conversations,
      messages,
    });
    const updatedAt = new Date().toISOString();
    if (result.conversationsChanged) {
      options.onChanged({ type: MESSAGING_BRIDGE_CHANGED_EVENT, scope: "conversations", updatedAt });
    }
    for (const roomId of result.changedRoomIds) {
      options.onChanged({ type: MESSAGING_BRIDGE_CHANGED_EVENT, scope: "messages", roomId, updatedAt });
    }
  }

  async function runWithLock(signal: AbortSignal, lostSignal: AbortSignal): Promise<void> {
    const cycle = AbortSignal.any([signal, lostSignal]);
    let failures = 0;
    while (!cycle.aborted) {
      try {
        await syncOnce(cycle);
        failures = 0;
        health = "ok";
      } catch (err: unknown) {
        if (cycle.aborted) return;
        if (err instanceof BridgeSyncPositionConflictError) continue;
        failures += 1;
        health = "unavailable";
        const wait = syncBackoffMs(failures, random);
        console.warn("[messages/bridge-sync] sync failed; backing off", errorName(err), wait);
        await sleep(wait, cycle);
      }
    }
  }

  async function run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      let handle: BridgeSyncLockHandle | null = null;
      try {
        handle = await options.lock.tryAcquire(options.ownerId);
      } catch (err: unknown) {
        console.warn("[messages/bridge-sync] sync lock unavailable", errorName(err));
      }
      if (!handle) {
        await sleep(lockRetryMs, signal);
        continue;
      }
      try {
        await runWithLock(signal, handle.lost);
      } finally {
        await handle.release();
      }
    }
  }

  return {
    syncOnce,
    running: () => loop !== null,
    health: () => health,
    ensureRunning() {
      if (loop) return;
      const current = new AbortController();
      controller = current;
      loop = run(current.signal)
        .catch((err: unknown) => {
          console.error("[messages/bridge-sync] sync loop stopped", errorName(err));
        })
        .finally(() => {
          if (controller === current) {
            controller = null;
            loop = null;
          }
        });
    },
    async stop() {
      const active = loop;
      controller?.abort();
      await active;
      health = "idle";
    },
  };
}
