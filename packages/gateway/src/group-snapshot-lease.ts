import type { MatrixClient } from './matrix-client.js';
import {
  SnapshotLeaseContentSchema,
  type SnapshotLeaseContent,
} from './group-types.js';

/**
 * SnapshotLeaseManager — spec §C snapshot_lease + spike §9.4 constants.
 *
 * A writer must hold a valid lease before publishing snapshot chunks. The
 * lease state event lives at
 *
 *   type      = `m.matrix_os.app.{app_slug}.snapshot_lease`
 *   state_key = `{app_slug}`        (NOT `""` — spec §C typo fix)
 *
 * Matrix room state LWW is the underlying coordination primitive: writers
 * race to PUT the lease, the loser observes the winner via /sync and
 * stands down. The grace period
 *
 *   GROUP_SYNC_SNAPSHOT_LEASE_GRACE_MS = 10_000ms
 *
 * prevents a new writer from pre-empting an observed-expired lease before
 * production jitter has resolved.
 *
 * This class owns NO filesystem state and NO network polling — it is
 * invoked on demand by `GroupSync.maybeWriteSnapshot()`.
 */

export interface SnapshotLeaseEnv {
  GROUP_SYNC_SNAPSHOT_LEASE_MS?: number;
  GROUP_SYNC_SNAPSHOT_LEASE_GRACE_MS?: number;
}

export interface SnapshotLeaseOptions {
  matrixClient: MatrixClient;
  roomId: string;
  selfHandle: string;
  env?: SnapshotLeaseEnv;
  /** For tests — inject deterministic clock. */
  clockNow?: () => number;
  /** For tests — inject deterministic lease_id generator. */
  leaseIdFactory?: () => string;
}

export interface AcquiredLease {
  leaseId: string;
  expiresAt: number;
}

const DEFAULT_LEASE_MS = 60_000;
const DEFAULT_GRACE_MS = 10_000;

// Crockford Base32 alphabet — matches the ULID regex in group-types.ts.
const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function randomUlid(): string {
  // 26 chars: 10 timestamp chars (48 bits) + 16 randomness chars (80 bits).
  // We don't actually need monotonic ULIDs for lease_id — any ULID-shaped
  // string that matches the schema is fine, since the schema only validates
  // structure. Use crypto for the randomness to keep collisions astronomical.
  const now = Date.now();
  const tsChars: string[] = [];
  let t = now;
  for (let i = 0; i < 10; i++) {
    tsChars.push(ULID_ALPHABET[t % 32]!);
    t = Math.floor(t / 32);
  }
  tsChars.reverse();

  const randBytes = new Uint8Array(16);
  // crypto.getRandomValues exists on Node 18+. Fall back to Math.random in
  // environments without it (tests).
  const globalCrypto = (globalThis as { crypto?: Crypto }).crypto;
  if (globalCrypto && typeof globalCrypto.getRandomValues === 'function') {
    globalCrypto.getRandomValues(randBytes);
  } else {
    for (let i = 0; i < randBytes.length; i++) {
      randBytes[i] = Math.floor(Math.random() * 256);
    }
  }
  const randChars: string[] = [];
  for (let i = 0; i < 16; i++) {
    randChars.push(ULID_ALPHABET[randBytes[i]! % 32]!);
  }

  return tsChars.join('') + randChars.join('');
}

export class SnapshotLeaseManager {
  private readonly client: MatrixClient;
  private readonly roomId: string;
  private readonly selfHandle: string;
  private readonly leaseDurationMs: number;
  private readonly graceMs: number;
  private readonly clockNow: () => number;
  private readonly leaseIdFactory: () => string;

  /** Per-app: the lease currently believed to be held by self. */
  private readonly selfHeld = new Map<string, AcquiredLease>();

  constructor(options: SnapshotLeaseOptions) {
    this.client = options.matrixClient;
    this.roomId = options.roomId;
    this.selfHandle = options.selfHandle;
    this.leaseDurationMs =
      options.env?.GROUP_SYNC_SNAPSHOT_LEASE_MS ?? DEFAULT_LEASE_MS;
    this.graceMs =
      options.env?.GROUP_SYNC_SNAPSHOT_LEASE_GRACE_MS ?? DEFAULT_GRACE_MS;
    this.clockNow = options.clockNow ?? Date.now;
    this.leaseIdFactory = options.leaseIdFactory ?? randomUlid;
  }

  /**
   * Attempt to acquire the lease for `appSlug`. Returns:
   *  - `{ leaseId, expiresAt }` on fresh acquisition
   *  - the existing lease when self-held and still valid
   *  - `null` when another writer holds a valid lease (caller should skip
   *    this snapshot window)
   */
  async tryAcquire(appSlug: string): Promise<AcquiredLease | null> {
    const eventType = this.leaseEventType(appSlug);
    const now = this.clockNow();

    const existing = await this.readLease(appSlug);
    if (existing !== null) {
      if (existing.writer === this.selfHandle && existing.expires_at > now) {
        // Reuse self-held lease.
        const reused: AcquiredLease = {
          leaseId: existing.lease_id,
          expiresAt: existing.expires_at,
        };
        this.selfHeld.set(appSlug, reused);
        return reused;
      }
      if (existing.writer !== this.selfHandle) {
        // Foreign lease — check if expired + past grace.
        const graceLine = existing.expires_at + this.graceMs;
        if (now <= graceLine) {
          // Still valid (or within grace): stand down.
          return null;
        }
        // Expired past grace — safe to pre-empt.
      }
      // else: self-held but expired — fall through to re-acquire.
    }

    // Write new lease.
    const leaseId = this.leaseIdFactory();
    const content: SnapshotLeaseContent = {
      v: 1,
      writer: this.selfHandle,
      lease_id: leaseId,
      acquired_at: now,
      expires_at: now + this.leaseDurationMs,
    };
    try {
      await this.client.setRoomState(
        this.roomId,
        eventType,
        appSlug,
        content as unknown as Record<string, unknown>,
      );
    } catch {
      // Leave selfHeld unchanged on write failure — caller will retry.
      return null;
    }
    const acquired: AcquiredLease = { leaseId, expiresAt: content.expires_at };
    this.selfHeld.set(appSlug, acquired);
    return acquired;
  }

  /**
   * Called from `GroupSync` when an inbound snapshot_lease event arrives.
   * If the new lease names a different writer, drop any self-held lease
   * for this app so in-flight snapshot writers stand down.
   */
  observeLease(appSlug: string, content: Record<string, unknown>): void {
    const parsed = SnapshotLeaseContentSchema.safeParse(content);
    if (!parsed.success) return;
    const lease = parsed.data;

    const held = this.selfHeld.get(appSlug);
    if (!held) return;
    if (lease.writer !== this.selfHandle || lease.lease_id !== held.leaseId) {
      // Another writer owns the lease now — stand down.
      this.selfHeld.delete(appSlug);
    } else {
      // Echo of our own lease — bump expiresAt to the canonical value.
      held.expiresAt = lease.expires_at;
    }
  }

  /**
   * True if this manager currently believes it holds the lease for `appSlug`.
   * Does NOT poll the homeserver — consult after a recent tryAcquire or
   * observeLease.
   */
  holdsLease(appSlug: string): boolean {
    const held = this.selfHeld.get(appSlug);
    if (!held) return false;
    return held.expiresAt > this.clockNow();
  }

  /** Return the active self-held lease id, or null if none. */
  getSelfLeaseId(appSlug: string): string | null {
    const held = this.selfHeld.get(appSlug);
    if (!held) return null;
    if (held.expiresAt <= this.clockNow()) {
      this.selfHeld.delete(appSlug);
      return null;
    }
    return held.leaseId;
  }

  // --------------------- helpers ---------------------

  private leaseEventType(appSlug: string): string {
    return `m.matrix_os.app.${appSlug}.snapshot_lease`;
  }

  private async readLease(appSlug: string): Promise<SnapshotLeaseContent | null> {
    const eventType = this.leaseEventType(appSlug);
    let raw;
    try {
      raw = await this.client.getRoomState(this.roomId, eventType, appSlug);
    } catch {
      return null;
    }
    if (raw === null) return null;
    const parsed = SnapshotLeaseContentSchema.safeParse(raw);
    if (!parsed.success) return null;
    return parsed.data;
  }
}
