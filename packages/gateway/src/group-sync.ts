import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import * as Y from 'yjs';

import {
  OpEventContentSchema,
  SnapshotEventContentSchema,
  type OpEventContent,
  type SnapshotEventContent,
  type GroupManifest,
} from './group-types.js';
import type { MatrixClient, MatrixRawEvent } from './matrix-client.js';
import { resolveWithinHome } from './path-security.js';
import { SnapshotLeaseManager } from './group-snapshot-lease.js';

/**
 * GroupSync — Yjs CRDT sync engine for a single Matrix room (spec 062, spec §E.2).
 *
 * Owns the authoritative `Y.Doc` for every shared app installed into this group.
 * Events flow in via handlers registered with `MatrixSyncHub`; local mutations
 * flow out via the constructor-injected `MatrixClient`.
 *
 * Wave 2 scope: hydrate → apply remote ops → apply local mutations → queue on
 * send failure → persist `state.bin` atomically → append `log.jsonl` →
 * quarantine corrupt updates. Snapshots, lease, chunking, resource caps, and
 * ACL enforcement land in later checkpoints / waves.
 */

// ---------------------------------------------------------------------------
// Coarse error codes — matches spec §J exactly. Extending the set is a spec
// change, not a code change.
// ---------------------------------------------------------------------------

export type GroupSyncErrorCode =
  | 'sync_failed'
  | 'acl_denied'
  | 'offline'
  | 'op_too_large'
  | 'state_overflow';

export type GroupSyncOnError = (
  code: GroupSyncErrorCode,
  detail: Record<string, unknown>,
) => void;

export interface GroupSyncOnChangeInfo {
  appSlug: string;
  origin: 'local' | 'remote';
  eventId: string | null;
  sender: string | null;
}

export type GroupSyncOnChange = (info: GroupSyncOnChangeInfo) => void;

export interface GroupSyncEnv {
  GROUP_STATE_MAX_BYTES?: number;
  GROUP_LOG_MAX_BYTES?: number;
  GROUP_LOG_RETENTION_DAYS?: number;
  GROUP_QUARANTINE_MAX?: number;
  GROUP_SYNC_QUEUE_MAX?: number;
  GROUP_SYNC_SNAPSHOT_LEASE_MS?: number;
  GROUP_SYNC_SNAPSHOT_LEASE_GRACE_MS?: number;
  GROUP_SYNC_SNAPSHOT_CHUNK_MAX_B64?: number;
  GROUP_SYNC_SNAPSHOT_TOTAL_MAX_B64?: number;
  GROUP_SYNC_SNAPSHOT_OPS_THRESHOLD?: number;
  GROUP_SYNC_SNAPSHOT_INTERVAL_MS?: number;
  GROUP_DOC_MAX_BYTES?: number;
}

export interface GroupSyncOptions {
  manifest: GroupManifest;
  homePath: string;
  matrixClient: MatrixClient;
  selfHandle: string;
  env?: GroupSyncEnv;
  onError?: GroupSyncOnError;
  clockNow?: () => number;
  /** If true, hydrate() does NOT read any existing state.bin — used by the
   *  corrupt-state quarantine path in server.ts (T041). */
  fresh?: boolean;
  /** Test-only write callback. NEVER use in production code. */
  debugOnWrite?: (path: string) => void;
}

interface FragmentGroup {
  groupId: string;
  count: number;
  firstSeenAt: number;
  // chunks[i] = undefined until chunk_seq.index=i arrives
  chunks: Array<string | undefined>;
}

interface AppState {
  appSlug: string;
  doc: Y.Doc;
  dataDir: string;
  lastEventId: string | null;
  lastSnapshotEventId: string | null;
  changeListeners: Set<GroupSyncOnChange>;
  /** Wall-clock ms of the first failed send since last success. `null` while
   *  the connection is believed healthy. Used by the 30-minute escalation
   *  path; cleared when a send succeeds or drainQueue runs clean. */
  firstFailureAt: number | null;
  /** True once the 30-minute escalation has been reported for the current
   *  failure window. Prevents the same event from firing every minute. */
  persistentEscalated: boolean;
  /** Number of inbound/outbound ops applied since the last successful
   *  snapshot write. Drives the 50-ops trigger. */
  opsSinceSnapshot: number;
  /** Wall-clock ms of the last successful snapshot write. Drives the 5-min
   *  trigger. */
  lastSnapshotAt: number;
  /** Inbound fragment reassembly buffer, keyed by `chunk_seq.group_id`.
   *  Bounded implicitly by the 60s TTL sweep in `tickFragmentGc`. */
  fragmentBuffer: Map<string, FragmentGroup>;
}

// ---------------------------------------------------------------------------
// Defaults — match spec §"Config injection" and Resource Management table.
// ---------------------------------------------------------------------------

const DEFAULT_STATE_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_LOG_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_LOG_RETENTION_DAYS = 30;
const DEFAULT_QUARANTINE_MAX = 100;
const DEFAULT_QUEUE_MAX = 10_000;
const DEFAULT_SNAPSHOT_CHUNK_MAX_B64 = 30_000;
const DEFAULT_SNAPSHOT_TOTAL_MAX_B64 = 256 * 1024;
const DEFAULT_SNAPSHOT_OPS_THRESHOLD = 50;
const DEFAULT_SNAPSHOT_INTERVAL_MS = 5 * 60 * 1000;

const BACKOFF_SCHEDULE_MS: readonly number[] = [
  1_000, 2_000, 4_000, 8_000, 16_000, 30_000,
];
const PERSISTENT_FAILURE_MS = 30 * 60 * 1000;

// Op chunking constants (spec §I + spike §9):
//   - single events top out at 32 KB raw (per `OpEventContent.update` field)
//   - fragments split at the same cap for uniformity
//   - oversize hard ceiling (1 MB raw) rejects with op_too_large
//   - inbound fragment buffer TTL is 60 s
const DEFAULT_OP_RAW_SINGLE_MAX = 32 * 1024;
const DEFAULT_OP_RAW_SPLITTABLE_MAX = 1 * 1024 * 1024;
const FRAGMENT_TTL_MS = 60_000;

// ---------------------------------------------------------------------------

export class GroupSync {
  private readonly manifest: GroupManifest;
  private readonly homePath: string;
  private readonly client: MatrixClient;
  private readonly selfHandle: string;
  private readonly env: Required<
    Pick<
      GroupSyncEnv,
      | 'GROUP_STATE_MAX_BYTES'
      | 'GROUP_LOG_MAX_BYTES'
      | 'GROUP_LOG_RETENTION_DAYS'
      | 'GROUP_QUARANTINE_MAX'
      | 'GROUP_SYNC_QUEUE_MAX'
      | 'GROUP_SYNC_SNAPSHOT_CHUNK_MAX_B64'
      | 'GROUP_SYNC_SNAPSHOT_TOTAL_MAX_B64'
      | 'GROUP_SYNC_SNAPSHOT_OPS_THRESHOLD'
      | 'GROUP_SYNC_SNAPSHOT_INTERVAL_MS'
    >
  >;
  private readonly onError: GroupSyncOnError;
  private readonly fresh: boolean;
  private readonly clockNow: () => number;
  private readonly debugOnWrite: ((path: string) => void) | undefined;
  private readonly apps = new Map<string, AppState>();
  private readonly leaseManager: SnapshotLeaseManager;
  private hydrated = false;

  constructor(options: GroupSyncOptions) {
    this.manifest = options.manifest;
    this.homePath = options.homePath;
    this.client = options.matrixClient;
    this.selfHandle = options.selfHandle;
    this.onError = options.onError ?? (() => undefined);
    this.fresh = options.fresh ?? false;
    this.clockNow = options.clockNow ?? Date.now;
    this.debugOnWrite = options.debugOnWrite;

    const env = options.env ?? {};
    this.env = {
      GROUP_STATE_MAX_BYTES: env.GROUP_STATE_MAX_BYTES ?? DEFAULT_STATE_MAX_BYTES,
      GROUP_LOG_MAX_BYTES: env.GROUP_LOG_MAX_BYTES ?? DEFAULT_LOG_MAX_BYTES,
      GROUP_LOG_RETENTION_DAYS: env.GROUP_LOG_RETENTION_DAYS ?? DEFAULT_LOG_RETENTION_DAYS,
      GROUP_QUARANTINE_MAX: env.GROUP_QUARANTINE_MAX ?? DEFAULT_QUARANTINE_MAX,
      GROUP_SYNC_QUEUE_MAX: env.GROUP_SYNC_QUEUE_MAX ?? DEFAULT_QUEUE_MAX,
      GROUP_SYNC_SNAPSHOT_CHUNK_MAX_B64:
        env.GROUP_SYNC_SNAPSHOT_CHUNK_MAX_B64 ?? DEFAULT_SNAPSHOT_CHUNK_MAX_B64,
      GROUP_SYNC_SNAPSHOT_TOTAL_MAX_B64:
        env.GROUP_SYNC_SNAPSHOT_TOTAL_MAX_B64 ?? DEFAULT_SNAPSHOT_TOTAL_MAX_B64,
      GROUP_SYNC_SNAPSHOT_OPS_THRESHOLD:
        env.GROUP_SYNC_SNAPSHOT_OPS_THRESHOLD ?? DEFAULT_SNAPSHOT_OPS_THRESHOLD,
      GROUP_SYNC_SNAPSHOT_INTERVAL_MS:
        env.GROUP_SYNC_SNAPSHOT_INTERVAL_MS ?? DEFAULT_SNAPSHOT_INTERVAL_MS,
    };

    this.leaseManager = new SnapshotLeaseManager({
      matrixClient: this.client,
      roomId: this.manifest.room_id,
      selfHandle: this.selfHandle,
      env: {
        GROUP_SYNC_SNAPSHOT_LEASE_MS: env.GROUP_SYNC_SNAPSHOT_LEASE_MS,
        GROUP_SYNC_SNAPSHOT_LEASE_GRACE_MS: env.GROUP_SYNC_SNAPSHOT_LEASE_GRACE_MS,
      },
      clockNow: this.clockNow,
    });
  }

  // --------------------- public lifecycle ---------------------

  /**
   * Enumerate installed apps under `~/groups/{slug}/apps/` and hydrate a Y.Doc
   * for each. If a state.bin exists and is readable, apply it; if it is
   * unreadable or corrupt, throw — the caller (server.ts) is responsible for
   * quarantine + retry-with-fresh=true per T041.
   */
  async hydrate(): Promise<void> {
    if (this.hydrated) return;

    const groupDir = this.resolveGroupDir();
    const appsDir = join(groupDir, 'apps');
    const appSlugs = await this.listAppSlugs(appsDir);

    for (const appSlug of appSlugs) {
      await this.hydrateApp(appSlug);
    }

    this.hydrated = true;
  }

  getDoc(appSlug: string): Y.Doc {
    const app = this.apps.get(appSlug);
    if (!app) {
      throw new Error(`GroupSync: no hydrated app "${appSlug}" in group "${this.manifest.slug}"`);
    }
    return app.doc;
  }

  onChange(appSlug: string, listener: GroupSyncOnChange): { dispose(): void } {
    const app = this.requireApp(appSlug);
    app.changeListeners.add(listener);
    return {
      dispose: () => {
        app.changeListeners.delete(listener);
      },
    };
  }

  // --------------------- remote op path ---------------------

  /**
   * Apply an inbound `m.matrix_os.app.{appSlug}.op` event to the local Y.Doc.
   *
   * Persistence order (spec §E.2 step 2 + Crash recovery invariant):
   *   1. apply update to in-memory Y.Doc
   *   2. write state.bin (atomic tmp+rename)
   *   3. append log.jsonl
   *   4. update last_sync.json (AFTER state.bin so crash recovery is idempotent)
   *   5. fire onChange listeners
   */
  async applyRemoteOp(appSlug: string, event: MatrixRawEvent): Promise<void> {
    const app = this.requireApp(appSlug);

    // Parse + validate every inbound event through OpEventContent.
    const parseResult = OpEventContentSchema.safeParse(event.content);
    if (!parseResult.success) {
      await this.quarantine(app, event, 'schema_parse_failed');
      this.onError('sync_failed', {
        reason: 'op_schema_parse_failed',
        appSlug,
        eventId: event.event_id ?? null,
      });
      return;
    }
    const content = parseResult.data;

    // Fragment reassembly: if chunk_seq is present, buffer and either return
    // early or assemble the full update. Only when we have every fragment in
    // the group do we continue to the decode/apply path.
    let mergedUpdateBase64 = content.update;
    if (content.chunk_seq) {
      const assembled = this.bufferFragment(app, content, event);
      if (assembled === null) {
        // Still waiting for more fragments — nothing to apply yet.
        return;
      }
      mergedUpdateBase64 = assembled;
    }

    // Decode base64 update bytes.
    let updateBytes: Uint8Array;
    try {
      updateBytes = decodeBase64Strict(mergedUpdateBase64);
    } catch (err) {
      await this.quarantine(app, event, 'base64_decode_failed');
      this.onError('sync_failed', {
        reason: 'op_base64_decode_failed',
        appSlug,
        eventId: event.event_id ?? null,
        error: (err as Error)?.message ?? 'unknown',
      });
      return;
    }

    // State cap: sandbox-apply to a clone and measure. If over cap, drop
    // the op and emit state_overflow. This keeps the real doc pristine.
    const priorBytes = Y.encodeStateAsUpdate(app.doc);
    const cloneDoc = new Y.Doc();
    Y.applyUpdate(cloneDoc, priorBytes);
    try {
      Y.applyUpdate(cloneDoc, updateBytes, 'remote');
    } catch (err) {
      await this.quarantine(app, event, 'yjs_apply_failed');
      this.onError('sync_failed', {
        reason: 'op_yjs_apply_failed',
        appSlug,
        eventId: event.event_id ?? null,
        error: (err as Error)?.message ?? 'unknown',
      });
      return;
    }
    const cloneBytes = Y.encodeStateAsUpdate(cloneDoc);
    if (cloneBytes.length > this.env.GROUP_STATE_MAX_BYTES) {
      this.onError('state_overflow', {
        reason: 'remote_op_would_exceed_state_cap',
        appSlug,
        eventId: event.event_id ?? null,
        cap: this.env.GROUP_STATE_MAX_BYTES,
        projectedBytes: cloneBytes.length,
      });
      return;
    }

    // Apply to the real Y.Doc inside a transaction so we can distinguish
    // local/remote in the observer.
    try {
      app.doc.transact(() => {
        Y.applyUpdate(app.doc, updateBytes, 'remote');
      }, 'remote');
    } catch (err) {
      await this.quarantine(app, event, 'yjs_apply_failed');
      this.onError('sync_failed', {
        reason: 'op_yjs_apply_failed',
        appSlug,
        eventId: event.event_id ?? null,
        error: (err as Error)?.message ?? 'unknown',
      });
      return;
    }

    // Persist state.bin, append log, bump last_sync — in that order.
    try {
      await this.persistState(app);
      await this.appendLog(app, {
        event_id: event.event_id ?? null,
        sender: event.sender ?? null,
        ts: content.ts,
        lamport: content.lamport,
        client_id: content.client_id,
      });
      await this.writeLastSync(app, event.event_id ?? null);
      app.opsSinceSnapshot += 1;
    } catch (err) {
      this.onError('sync_failed', {
        reason: 'op_persist_failed',
        appSlug,
        eventId: event.event_id ?? null,
        error: (err as Error)?.message ?? 'unknown',
      });
      return;
    }

    // Notify listeners after durable persistence.
    for (const listener of Array.from(app.changeListeners)) {
      try {
        listener({
          appSlug,
          origin: 'remote',
          eventId: event.event_id ?? null,
          sender: event.sender ?? null,
        });
      } catch {
        // listener failures must not break dispatch
      }
    }
  }

  /**
   * Buffer an inbound fragment. Returns the merged base64 update string once
   * the group is complete, or `null` while still assembling.
   */
  private bufferFragment(
    app: AppState,
    content: OpEventContent,
    event: MatrixRawEvent,
  ): string | null {
    const seq = content.chunk_seq!;
    let group = app.fragmentBuffer.get(seq.group_id);
    if (!group) {
      group = {
        groupId: seq.group_id,
        count: seq.count,
        firstSeenAt: this.clockNow(),
        chunks: new Array(seq.count).fill(undefined),
      };
      app.fragmentBuffer.set(seq.group_id, group);
    }
    if (group.count !== seq.count) {
      // Inconsistent chunk_count within the same group — drop the old group
      // and start fresh with the new fragment's view.
      app.fragmentBuffer.delete(seq.group_id);
      group = {
        groupId: seq.group_id,
        count: seq.count,
        firstSeenAt: this.clockNow(),
        chunks: new Array(seq.count).fill(undefined),
      };
      app.fragmentBuffer.set(seq.group_id, group);
    }
    if (seq.index < 0 || seq.index >= seq.count) {
      // Malformed index — drop the whole group to avoid memory leaks.
      app.fragmentBuffer.delete(seq.group_id);
      this.onError('sync_failed', {
        reason: 'fragment_index_out_of_range',
        appSlug: app.appSlug,
        groupId: seq.group_id,
        index: seq.index,
        count: seq.count,
      });
      return null;
    }
    group.chunks[seq.index] = content.update;

    // Complete?
    for (const chunk of group.chunks) {
      if (chunk === undefined) return null;
    }
    // Assemble and drop the group from the buffer.
    const merged = (group.chunks as string[]).join('');
    app.fragmentBuffer.delete(seq.group_id);
    return merged;
  }

  /**
   * Sweep fragment buffers for any group whose `firstSeenAt` is older than
   * the TTL. Drops partial groups and emits a logged warning. Callers
   * invoke this on a timer (`setInterval(() => sync.tickFragmentGc(), ...)`)
   * — the class does not own the timer so tests can step the clock.
   */
  tickFragmentGc(): void {
    const now = this.clockNow();
    for (const app of this.apps.values()) {
      for (const [groupId, group] of Array.from(app.fragmentBuffer.entries())) {
        if (now - group.firstSeenAt >= FRAGMENT_TTL_MS) {
          app.fragmentBuffer.delete(groupId);
          const received = group.chunks.filter((c) => c !== undefined).length;
          this.onError('sync_failed', {
            reason: 'fragment_timeout',
            appSlug: app.appSlug,
            groupId,
            receivedCount: received,
            expectedCount: group.count,
          });
        }
      }
    }
  }

  // --------------------- local mutation path ---------------------

  /**
   * Apply a local mutation produced by an iframe / IPC / WS client. Encodes
   * the resulting Yjs update as a `m.matrix_os.app.{appSlug}.op` event, sends
   * it, and persists. On send failure, the update is appended to queue.jsonl
   * (checkpoint 3 drains the queue on reconnect).
   */
  async applyLocalMutation(
    appSlug: string,
    mutator: (doc: Y.Doc) => void,
  ): Promise<void> {
    const app = this.requireApp(appSlug);

    // Snapshot the state vector BEFORE the local mutation so we can encode
    // only the delta rather than the full doc state.
    const prevStateVector = Y.encodeStateVector(app.doc);
    // Also save the full pre-mutation state for rollback on cap overflow.
    const priorBytes = Y.encodeStateAsUpdate(app.doc);

    try {
      app.doc.transact(() => {
        mutator(app.doc);
      }, 'local');
    } catch (err) {
      this.onError('sync_failed', {
        reason: 'local_mutation_threw',
        appSlug,
        error: (err as Error)?.message ?? 'unknown',
      });
      return;
    }

    // Enforce state.bin cap post-mutation. If the new state would exceed the
    // cap, roll the doc back to its prior bytes and emit state_overflow.
    const newStateBytes = Y.encodeStateAsUpdate(app.doc);
    if (newStateBytes.length > this.env.GROUP_STATE_MAX_BYTES) {
      // Replace in-memory doc with a fresh one loaded from priorBytes. This
      // preserves changeListeners (stored on `app`, not on the doc).
      const rolled = new Y.Doc();
      Y.applyUpdate(rolled, priorBytes);
      app.doc = rolled;
      this.onError('state_overflow', {
        reason: 'local_mutation_would_exceed_state_cap',
        appSlug,
        cap: this.env.GROUP_STATE_MAX_BYTES,
        projectedBytes: newStateBytes.length,
      });
      return;
    }

    const update = Y.encodeStateAsUpdate(app.doc, prevStateVector);
    // Empty update = no-op mutation; skip the network send.
    if (update.length === 0) {
      return;
    }

    // Size gate: reject updates that exceed the splittable ceiling outright.
    if (update.length > DEFAULT_OP_RAW_SPLITTABLE_MAX) {
      // Roll back — the doc already reflects the mutation but we refuse to
      // emit it.
      const rolled = new Y.Doc();
      Y.applyUpdate(rolled, priorBytes);
      app.doc = rolled;
      this.onError('op_too_large', {
        reason: 'local_op_exceeds_splittable_ceiling',
        appSlug,
        rawBytes: update.length,
        cap: DEFAULT_OP_RAW_SPLITTABLE_MAX,
      });
      return;
    }

    const contentsToSend = this.buildOutboundContents(app, update);

    // Send each (single or fragment) via Matrix. On first failure, queue
    // everything remaining for retry.
    let sendOk = true;
    for (let i = 0; i < contentsToSend.length; i++) {
      const content = contentsToSend[i]!;
      try {
        await this.client.sendCustomEvent(
          this.manifest.room_id,
          `m.matrix_os.app.${appSlug}.op`,
          content as unknown as Record<string, unknown>,
        );
      } catch (err) {
        sendOk = false;
        // Queue this + remaining fragments so ordering is preserved.
        for (let j = i; j < contentsToSend.length; j++) {
          await this.enqueueForRetry(app, contentsToSend[j]!, err);
        }
        break;
      }
    }
    if (sendOk) {
      this.markSendSuccess(app);
    }

    // Persist local state regardless — optimistic: the doc is the source of
    // truth for this user; queue.jsonl replays the mutation when the network
    // returns.
    try {
      await this.persistState(app);
      app.opsSinceSnapshot += 1;
    } catch (err) {
      this.onError('sync_failed', {
        reason: 'local_persist_failed',
        appSlug,
        error: (err as Error)?.message ?? 'unknown',
      });
    }

    for (const listener of Array.from(app.changeListeners)) {
      try {
        listener({
          appSlug,
          origin: 'local',
          eventId: null,
          sender: this.selfHandle,
        });
      } catch {
        // listener failures must not break dispatch
      }
    }
  }

  /**
   * Build the outbound `OpEventContent` values for a Yjs update. Single
   * events if the raw update is ≤ DEFAULT_OP_RAW_SINGLE_MAX, otherwise split
   * into fragments with a shared `chunk_seq.group_id`.
   */
  private buildOutboundContents(app: AppState, update: Uint8Array): OpEventContent[] {
    const lamport = this.clockNow();
    const clientId = `kernel-${this.manifest.slug}`;
    const origin = this.selfHandle;
    const ts = this.clockNow();

    if (update.length <= DEFAULT_OP_RAW_SINGLE_MAX) {
      return [
        {
          v: 1,
          update: Buffer.from(update).toString('base64'),
          lamport,
          client_id: clientId,
          origin,
          ts,
        },
      ];
    }

    // Split the base64-encoded update into fragments. We split on base64
    // char boundaries so the reassembler can just string-concat.
    const fullBase64 = Buffer.from(update).toString('base64');
    // Base64 char count that corresponds to DEFAULT_OP_RAW_SINGLE_MAX raw
    // bytes: ceil(raw * 4/3). We stay conservative: use 32KB as the base64
    // char budget too (that's ~24KB raw per fragment, which is well within
    // the 32KB raw cap).
    const fragChars = DEFAULT_OP_RAW_SINGLE_MAX;
    const parts: string[] = [];
    for (let i = 0; i < fullBase64.length; i += fragChars) {
      parts.push(fullBase64.slice(i, i + fragChars));
    }
    const groupId = generateUlid();
    return parts.map((part, idx) => ({
      v: 1,
      update: part,
      lamport,
      client_id: clientId,
      origin,
      ts,
      chunk_seq: { index: idx, count: parts.length, group_id: groupId },
    }));
  }

  // --------------------- private helpers ---------------------

  private requireApp(appSlug: string): AppState {
    const app = this.apps.get(appSlug);
    if (!app) {
      throw new Error(
        `GroupSync: app "${appSlug}" not hydrated in group "${this.manifest.slug}"`,
      );
    }
    return app;
  }

  private resolveGroupDir(): string {
    const groupDir = resolveWithinHome(this.homePath, join('groups', this.manifest.slug));
    if (!groupDir) {
      throw new Error(
        `GroupSync: path traversal detected for group slug "${this.manifest.slug}"`,
      );
    }
    return groupDir;
  }

  private resolveDataDir(appSlug: string): string {
    const dataDir = resolveWithinHome(
      this.homePath,
      join('groups', this.manifest.slug, 'data', appSlug),
    );
    if (!dataDir) {
      throw new Error(
        `GroupSync: path traversal detected for app slug "${appSlug}"`,
      );
    }
    return dataDir;
  }

  private async listAppSlugs(appsDir: string): Promise<string[]> {
    try {
      const entries = await fs.readdir(appsDir, { withFileTypes: true });
      return entries.filter((e) => e.isDirectory()).map((e) => e.name);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return [];
      throw err;
    }
  }

  private async hydrateApp(appSlug: string): Promise<void> {
    const dataDir = this.resolveDataDir(appSlug);
    await fs.mkdir(dataDir, { recursive: true });

    const doc = new Y.Doc();
    const stateBinPath = join(dataDir, 'state.bin');
    const lastSyncPath = join(dataDir, 'last_sync.json');

    if (!this.fresh) {
      try {
        const stateBytes = await fs.readFile(stateBinPath);
        if (stateBytes.length > 0) {
          Y.applyUpdate(doc, stateBytes, 'hydrate');
        }
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
          // new app, empty doc is correct
        } else {
          // Re-throw corruption / IO errors — caller (server.ts T041) quarantines.
          throw new GroupSyncHydrateError(
            `hydrate failed for app "${appSlug}" in group "${this.manifest.slug}": ${
              (err as Error).message
            }`,
            { cause: err as Error },
          );
        }
      }
    }

    let lastEventId: string | null = null;
    let lastSnapshotEventId: string | null = null;
    if (!this.fresh) {
      try {
        const raw = await fs.readFile(lastSyncPath, 'utf-8');
        const parsed = JSON.parse(raw) as {
          last_event_id?: unknown;
          last_snapshot_event_id?: unknown;
        };
        if (typeof parsed.last_event_id === 'string') lastEventId = parsed.last_event_id;
        if (typeof parsed.last_snapshot_event_id === 'string') {
          lastSnapshotEventId = parsed.last_snapshot_event_id;
        }
      } catch {
        // absent or corrupt — start from null, will be overwritten on next op
      }
    }

    this.apps.set(appSlug, {
      appSlug,
      doc,
      dataDir,
      lastEventId,
      lastSnapshotEventId,
      changeListeners: new Set(),
      firstFailureAt: null,
      persistentEscalated: false,
      opsSinceSnapshot: 0,
      lastSnapshotAt: 0,
      fragmentBuffer: new Map(),
    });
  }

  private async persistState(app: AppState): Promise<void> {
    const stateBinPath = join(app.dataDir, 'state.bin');
    const bytes = Y.encodeStateAsUpdate(app.doc);
    await atomicWriteFile(stateBinPath, Buffer.from(bytes));
    this.debugOnWrite?.(stateBinPath);
  }

  private async appendLog(
    app: AppState,
    entry: {
      event_id: string | null;
      sender: string | null;
      ts: number;
      lamport: number;
      client_id: string;
    },
  ): Promise<void> {
    const logPath = join(app.dataDir, 'log.jsonl');
    const line = `${JSON.stringify(entry)}\n`;
    await fs.appendFile(logPath, line, { encoding: 'utf-8' });
    this.debugOnWrite?.(logPath);
    await this.rotateLogIfNeeded(app, logPath);
  }

  /**
   * Rotate log.jsonl if it exceeds GROUP_LOG_MAX_BYTES. Rotation keeps the
   * newest half (approximately) and writes atomically. The 30-day retention
   * is enforced lazily here: entries whose `ts` is older than N days are
   * dropped during rotation.
   */
  private async rotateLogIfNeeded(app: AppState, logPath: string): Promise<void> {
    let st;
    try {
      st = await fs.stat(logPath);
    } catch {
      return;
    }
    if (st.size <= this.env.GROUP_LOG_MAX_BYTES) return;

    let raw: string;
    try {
      raw = await fs.readFile(logPath, 'utf-8');
    } catch {
      return;
    }
    const lines = raw.split('\n').filter((l) => l.length > 0);
    const cutoffMs =
      this.clockNow() - this.env.GROUP_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    const kept: string[] = [];
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as { ts?: number };
        if (typeof parsed.ts === 'number' && parsed.ts < cutoffMs) continue;
      } catch {
        continue;
      }
      kept.push(line);
    }
    // Drop the oldest half until we're under cap.
    let targetBytes = Math.floor(this.env.GROUP_LOG_MAX_BYTES / 2);
    let acc = 0;
    const tail: string[] = [];
    for (let i = kept.length - 1; i >= 0; i--) {
      const l = kept[i]!;
      const bytes = Buffer.byteLength(l, 'utf-8') + 1;
      if (acc + bytes > targetBytes && tail.length > 0) break;
      acc += bytes;
      tail.unshift(l);
    }
    const rewritten = tail.join('\n') + (tail.length > 0 ? '\n' : '');
    await atomicWriteFile(logPath, rewritten);
    this.debugOnWrite?.(logPath);
  }

  private async writeLastSync(app: AppState, lastEventId: string | null): Promise<void> {
    if (lastEventId !== null) {
      app.lastEventId = lastEventId;
    }
    const lastSyncPath = join(app.dataDir, 'last_sync.json');
    const body = JSON.stringify({
      last_event_id: app.lastEventId,
      last_snapshot_event_id: app.lastSnapshotEventId,
    });
    await atomicWriteFile(lastSyncPath, body);
    this.debugOnWrite?.(lastSyncPath);
  }

  private async quarantine(
    app: AppState,
    event: MatrixRawEvent,
    reason: string,
  ): Promise<void> {
    const quarantinePath = join(app.dataDir, 'quarantine.jsonl');
    const entry = {
      reason,
      event_id: event.event_id ?? null,
      sender: event.sender ?? null,
      origin_server_ts: event.origin_server_ts ?? null,
      type: event.type,
      content: event.content,
      quarantined_at: this.clockNow(),
    };
    try {
      await fs.appendFile(quarantinePath, `${JSON.stringify(entry)}\n`, {
        encoding: 'utf-8',
      });
      this.debugOnWrite?.(quarantinePath);
    } catch (err) {
      // Quarantine must not crash the sync loop; log via onError and continue.
      this.onError('sync_failed', {
        reason: 'quarantine_write_failed',
        appSlug: app.appSlug,
        error: (err as Error)?.message ?? 'unknown',
      });
      return;
    }
    // Enforce cap with drop-oldest.
    await this.enforceQuarantineCap(app, quarantinePath);
  }

  private async enforceQuarantineCap(
    app: AppState,
    quarantinePath: string,
  ): Promise<void> {
    const cap = this.env.GROUP_QUARANTINE_MAX;
    let raw: string;
    try {
      raw = await fs.readFile(quarantinePath, 'utf-8');
    } catch {
      return;
    }
    const lines = raw.split('\n').filter((l) => l.length > 0);
    if (lines.length <= cap) return;
    const evicted = lines.length - cap;
    const kept = lines.slice(evicted);
    const rewritten = kept.join('\n') + (kept.length > 0 ? '\n' : '');
    await atomicWriteFile(quarantinePath, rewritten);
    this.debugOnWrite?.(quarantinePath);
    this.onError('sync_failed', {
      reason: 'quarantine_evicted_oldest',
      appSlug: app.appSlug,
      evictedCount: evicted,
      cap,
    });
  }

  private async enqueueForRetry(
    app: AppState,
    content: OpEventContent,
    cause: unknown,
  ): Promise<void> {
    const queuePath = join(app.dataDir, 'queue.jsonl');
    const entry = {
      queued_at: this.clockNow(),
      content,
    };

    // Append first — simple, atomic for single lines on POSIX.
    try {
      await fs.appendFile(queuePath, `${JSON.stringify(entry)}\n`, {
        encoding: 'utf-8',
      });
      this.debugOnWrite?.(queuePath);
    } catch (err) {
      this.onError('sync_failed', {
        reason: 'queue_write_failed',
        appSlug: app.appSlug,
        error: (err as Error)?.message ?? 'unknown',
      });
      return;
    }

    // Enforce cap with drop-oldest rotation. We read the file back, truncate
    // the oldest lines, and rewrite atomically. This is O(N) in queue size on
    // every overrun, but the cap is rare (10 000 events) and the file is tiny.
    await this.enforceQueueCap(app, queuePath);

    // Track failure window for the 30-minute escalation.
    const now = this.clockNow();
    if (app.firstFailureAt === null) {
      app.firstFailureAt = now;
    }
    const failureAge = now - app.firstFailureAt;

    this.onError('offline', {
      reason: 'send_failed_queued',
      appSlug: app.appSlug,
      cause: (cause as Error)?.message ?? 'unknown',
      failureAgeMs: failureAge,
    });

    if (failureAge >= PERSISTENT_FAILURE_MS && !app.persistentEscalated) {
      app.persistentEscalated = true;
      this.onError('sync_failed', {
        reason: 'persistent_send_failures',
        appSlug: app.appSlug,
        failureAgeMs: failureAge,
      });
    }
  }

  private async enforceQueueCap(app: AppState, queuePath: string): Promise<void> {
    const cap = this.env.GROUP_SYNC_QUEUE_MAX;
    let raw: string;
    try {
      raw = await fs.readFile(queuePath, 'utf-8');
    } catch {
      return;
    }
    const lines = raw.split('\n').filter((l) => l.length > 0);
    if (lines.length <= cap) return;

    const evicted = lines.length - cap;
    const kept = lines.slice(evicted);
    const rewritten = kept.join('\n') + (kept.length > 0 ? '\n' : '');
    await atomicWriteFile(queuePath, rewritten);
    this.debugOnWrite?.(queuePath);

    this.onError('offline', {
      reason: 'queue_evicted_oldest',
      appSlug: app.appSlug,
      evictedCount: evicted,
      cap,
    });
  }

  private markSendSuccess(app: AppState): void {
    app.firstFailureAt = null;
    app.persistentEscalated = false;
  }

  /**
   * Drain queue.jsonl for every app in this group. Replays ops in append
   * order (oldest first). On a send failure the remaining ops stay in the
   * queue for the next attempt.
   */
  async drainQueue(): Promise<void> {
    for (const app of this.apps.values()) {
      await this.drainQueueForApp(app);
    }
  }

  private async drainQueueForApp(app: AppState): Promise<void> {
    const queuePath = join(app.dataDir, 'queue.jsonl');
    let raw: string;
    try {
      raw = await fs.readFile(queuePath, 'utf-8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return;
      throw err;
    }
    const lines = raw.split('\n').filter((l) => l.length > 0);
    if (lines.length === 0) {
      // Empty queue — nothing to do, but truncate to drop stale empty file.
      await atomicWriteFile(queuePath, '');
      return;
    }

    const remaining: string[] = [];
    let anyReplayed = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      // Lazily parse: if parse fails, drop the line — it's malformed and we
      // can't recover.
      let entry: { content?: OpEventContent } | null = null;
      try {
        entry = JSON.parse(line) as { content?: OpEventContent };
      } catch {
        continue;
      }
      if (!entry?.content) continue;

      try {
        await this.client.sendCustomEvent(
          this.manifest.room_id,
          `m.matrix_os.app.${app.appSlug}.op`,
          entry.content as unknown as Record<string, unknown>,
        );
        anyReplayed = true;
      } catch {
        // Send failed — keep this op and every op after it in the queue so
        // order is preserved for the next drain.
        remaining.push(...lines.slice(i));
        break;
      }
    }

    const rewritten = remaining.length > 0 ? remaining.join('\n') + '\n' : '';
    await atomicWriteFile(queuePath, rewritten);
    this.debugOnWrite?.(queuePath);

    if (remaining.length === 0 && anyReplayed) {
      this.markSendSuccess(app);
    }
  }

  // --------------------- snapshot writer ---------------------

  /**
   * Attempt to write a fresh snapshot of the app's Y.Doc to Matrix room
   * state. Returns the `snapshot_id` on success, or `null` on any skip path:
   *   - lease held by another writer
   *   - no lease acquired (e.g. setRoomState failed)
   *   - total snapshot size exceeds GROUP_SYNC_SNAPSHOT_TOTAL_MAX_B64
   *   - chunk upload fails partway (partial writes DO land but subsequent
   *     readers reject mixed sets; the next writer starts a fresh snapshot_id)
   *
   * The trigger policy (op count, interval) is checked unless `force: true`.
   */
  async maybeWriteSnapshot(
    appSlug: string,
    options: { force?: boolean } = {},
  ): Promise<string | null> {
    const app = this.requireApp(appSlug);
    const now = this.clockNow();

    if (!options.force) {
      const shouldTrigger =
        app.opsSinceSnapshot >= this.env.GROUP_SYNC_SNAPSHOT_OPS_THRESHOLD ||
        now - app.lastSnapshotAt >= this.env.GROUP_SYNC_SNAPSHOT_INTERVAL_MS;
      if (!shouldTrigger) return null;
    }

    // Lease gate.
    const acquired = await this.leaseManager.tryAcquire(appSlug);
    if (!acquired) {
      return null;
    }

    // Encode current Y.Doc state.
    const stateBytes = Y.encodeStateAsUpdate(app.doc);
    const base64 = Buffer.from(stateBytes).toString('base64');

    const totalCap = this.env.GROUP_SYNC_SNAPSHOT_TOTAL_MAX_B64;
    if (base64.length > totalCap) {
      this.onError('sync_failed', {
        reason: 'snapshot_oversize',
        appSlug,
        base64Bytes: base64.length,
        cap: totalCap,
      });
      return null;
    }

    const chunkCap = this.env.GROUP_SYNC_SNAPSHOT_CHUNK_MAX_B64;
    const chunks: string[] = [];
    for (let i = 0; i < base64.length; i += chunkCap) {
      chunks.push(base64.slice(i, i + chunkCap));
    }
    if (chunks.length === 0) {
      return null;
    }

    const snapshotId = acquired.leaseId; // lease_id == snapshot_id per spec §C
    const eventType = `m.matrix_os.app.${appSlug}.snapshot`;
    const takenAtEventId = app.lastEventId ?? '$genesis';
    let written = 0;

    for (let i = 0; i < chunks.length; i++) {
      const content: SnapshotEventContent = {
        v: 1,
        snapshot_id: snapshotId,
        generation: now,
        chunk_index: i,
        chunk_count: chunks.length,
        state: chunks[i]!,
        taken_at_event_id: takenAtEventId,
        taken_at: now,
        written_by: this.selfHandle,
      };
      try {
        await this.client.setRoomState(
          this.manifest.room_id,
          eventType,
          `${snapshotId}/${i}`,
          content as unknown as Record<string, unknown>,
        );
        written += 1;
      } catch (err) {
        this.onError('sync_failed', {
          reason: 'snapshot_chunk_write_failed',
          appSlug,
          snapshotId,
          chunkIndex: i,
          written,
          total: chunks.length,
          error: (err as Error)?.message ?? 'unknown',
        });
        return null;
      }
    }

    app.lastSnapshotAt = now;
    app.opsSinceSnapshot = 0;
    app.lastSnapshotEventId = snapshotId;
    return snapshotId;
  }

  /**
   * Observe an inbound snapshot_lease event and forward to the lease
   * manager. Called by the /sync event handler once it is registered.
   */
  observeSnapshotLease(appSlug: string, content: Record<string, unknown>): void {
    this.leaseManager.observeLease(appSlug, content);
  }

  // --------------------- snapshot reader ---------------------

  /**
   * Load the highest-generation complete snapshot for an app from Matrix room
   * state. Returns the decoded Yjs update bytes, or `null` if no complete
   * snapshot is available (caller must fall back to full timeline replay).
   *
   * Atomicity contract (spec §C): chunks are grouped by `snapshot_id`; only
   * sets where every `chunk_index` in `0..chunk_count-1` is present and the
   * `snapshot_id` matches are considered complete. Mixed sets from concurrent
   * writers are dropped — the highest-generation *complete* set wins, NOT the
   * highest-generation mixed set.
   */
  async loadLatestSnapshot(appSlug: string): Promise<Uint8Array | null> {
    const eventType = `m.matrix_os.app.${appSlug}.snapshot`;
    let rawEvents;
    try {
      rawEvents = await this.client.getAllRoomStateEvents(this.manifest.room_id, eventType);
    } catch (err) {
      this.onError('sync_failed', {
        reason: 'snapshot_fetch_failed',
        appSlug,
        error: (err as Error)?.message ?? 'unknown',
      });
      return null;
    }
    if (!Array.isArray(rawEvents) || rawEvents.length === 0) return null;

    // Group by (generation, snapshot_id). We bucket by the composite key so
    // that a misbehaving writer publishing two different snapshot_ids at the
    // same generation doesn't merge their chunks.
    interface Bucket {
      snapshotId: string;
      generation: number;
      chunkCount: number;
      chunksByIndex: Map<number, string>;
    }
    const buckets = new Map<string, Bucket>();
    for (const raw of rawEvents) {
      const parsed = SnapshotEventContentSchema.safeParse(raw.content);
      if (!parsed.success) continue;
      const content = parsed.data;

      // Reject mismatched state_key: the canonical state_key is
      // `${snapshot_id}/${chunk_index}`. Chunks that disagree are corrupt.
      const expectedKey = `${content.snapshot_id}/${content.chunk_index}`;
      if (raw.state_key !== undefined && raw.state_key !== expectedKey) {
        continue;
      }

      const bucketKey = `${content.generation}::${content.snapshot_id}`;
      let bucket = buckets.get(bucketKey);
      if (!bucket) {
        bucket = {
          snapshotId: content.snapshot_id,
          generation: content.generation,
          chunkCount: content.chunk_count,
          chunksByIndex: new Map(),
        };
        buckets.set(bucketKey, bucket);
      }
      // If chunk_count disagrees across chunks within the same snapshot_id,
      // the set is internally inconsistent; drop the bucket entirely.
      if (bucket.chunkCount !== content.chunk_count) {
        buckets.delete(bucketKey);
        continue;
      }
      bucket.chunksByIndex.set(content.chunk_index, content.state);
    }

    // Filter to complete buckets, sort by generation descending, pick the
    // highest that decodes successfully.
    const completeBuckets = Array.from(buckets.values())
      .filter((b) => b.chunksByIndex.size === b.chunkCount)
      .filter((b) => {
        // Ensure every 0..chunk_count-1 index is present (no duplicates and
        // no gaps hidden by map-key collisions).
        for (let i = 0; i < b.chunkCount; i++) {
          if (!b.chunksByIndex.has(i)) return false;
        }
        return true;
      })
      .sort((a, b) => b.generation - a.generation);

    for (const bucket of completeBuckets) {
      const orderedParts: string[] = [];
      for (let i = 0; i < bucket.chunkCount; i++) {
        orderedParts.push(bucket.chunksByIndex.get(i)!);
      }
      const concatenated = orderedParts.join('');
      try {
        return decodeBase64Strict(concatenated);
      } catch {
        // This bucket is internally corrupt; try the next-highest generation.
        continue;
      }
    }
    return null;
  }

  /**
   * Exponential backoff schedule for outbound send failures. Matches spec §F
   * "Error propagation": `[1s, 2s, 4s, 8s, 16s, 30s]` cap.
   */
  getNextBackoffMs(attempt: number): number {
    if (attempt < 0) return BACKOFF_SCHEDULE_MS[0]!;
    const capIdx = BACKOFF_SCHEDULE_MS.length - 1;
    const idx = Math.min(attempt, capIdx);
    return BACKOFF_SCHEDULE_MS[idx]!;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export class GroupSyncHydrateError extends Error {
  override readonly name = 'GroupSyncHydrateError' as const;
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

/**
 * Atomic file write: write to a tmp file, then rename.
 * Matches the CLAUDE.md atomicity rule for 2+ related writes and provides
 * crash-safety for `state.bin` / `last_sync.json` updates.
 */
async function atomicWriteFile(path: string, data: string | Buffer): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await fs.writeFile(tmp, data, { flag: 'w' });
  await fs.rename(tmp, path);
}

/**
 * Generate a ULID-shaped identifier for fragment `group_id` / snapshot
 * `lease_id`. 26 chars, Crockford Base32. Matches the `ULID_REGEX` in
 * `group-types.ts` so the envelope schema parses cleanly.
 */
const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function generateUlid(): string {
  const now = Date.now();
  const tsChars: string[] = [];
  let t = now;
  for (let i = 0; i < 10; i++) {
    tsChars.push(ULID_ALPHABET[t % 32]!);
    t = Math.floor(t / 32);
  }
  tsChars.reverse();
  const randChars: string[] = [];
  const rnd = new Uint8Array(16);
  const g = (globalThis as { crypto?: Crypto }).crypto;
  if (g && typeof g.getRandomValues === 'function') {
    g.getRandomValues(rnd);
  } else {
    for (let i = 0; i < 16; i++) rnd[i] = Math.floor(Math.random() * 256);
  }
  for (let i = 0; i < 16; i++) randChars.push(ULID_ALPHABET[rnd[i]! % 32]!);
  return tsChars.join('') + randChars.join('');
}

/**
 * Strict base64 decoder that rejects input containing characters outside the
 * canonical base64 alphabet. `Buffer.from(s, "base64")` silently drops invalid
 * chars, which would let a malformed update slip through the apply path.
 */
function decodeBase64Strict(input: string): Uint8Array {
  const canonical = /^[A-Za-z0-9+/]*={0,2}$/;
  if (!canonical.test(input)) {
    throw new Error('input contains non-base64 characters');
  }
  // base64 length must be a multiple of 4
  if (input.length % 4 !== 0) {
    throw new Error('base64 length is not a multiple of 4');
  }
  return new Uint8Array(Buffer.from(input, 'base64'));
}
