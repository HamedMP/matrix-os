import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import * as Y from 'yjs';

import {
  OpEventContentSchema,
  type OpEventContent,
  type GroupManifest,
} from './group-types.js';
import type { MatrixClient, MatrixRawEvent } from './matrix-client.js';
import { resolveWithinHome } from './path-security.js';

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

interface AppState {
  appSlug: string;
  doc: Y.Doc;
  dataDir: string;
  lastEventId: string | null;
  lastSnapshotEventId: string | null;
  changeListeners: Set<GroupSyncOnChange>;
}

// ---------------------------------------------------------------------------
// Defaults — match spec §"Config injection" and Resource Management table.
// ---------------------------------------------------------------------------

const DEFAULT_STATE_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_LOG_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_LOG_RETENTION_DAYS = 30;
const DEFAULT_QUARANTINE_MAX = 100;
const DEFAULT_QUEUE_MAX = 10_000;

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
    >
  >;
  private readonly onError: GroupSyncOnError;
  private readonly fresh: boolean;
  private readonly clockNow: () => number;
  private readonly debugOnWrite: ((path: string) => void) | undefined;
  private readonly apps = new Map<string, AppState>();
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
    };
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

    // Decode base64 update bytes.
    let updateBytes: Uint8Array;
    try {
      updateBytes = decodeBase64Strict(content.update);
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

    // Apply to Y.Doc inside a transaction so we can distinguish local/remote.
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

    const update = Y.encodeStateAsUpdate(app.doc, prevStateVector);
    // Empty update = no-op mutation; skip the network send.
    if (update.length === 0) {
      return;
    }

    const content: OpEventContent = {
      v: 1,
      update: Buffer.from(update).toString('base64'),
      lamport: this.clockNow(),
      client_id: `kernel-${this.manifest.slug}`,
      origin: this.selfHandle,
      ts: this.clockNow(),
    };

    // Send via Matrix. On failure, fall through to the queue path.
    let sendOk = false;
    try {
      await this.client.sendCustomEvent(
        this.manifest.room_id,
        `m.matrix_os.app.${appSlug}.op`,
        content as unknown as Record<string, unknown>,
      );
      sendOk = true;
    } catch (err) {
      await this.enqueueForRetry(app, content, err);
    }

    // Persist local state regardless — optimistic: the doc is the source of
    // truth for this user; queue.jsonl replays the mutation when the network
    // returns.
    try {
      await this.persistState(app);
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
          eventId: sendOk ? null : null,
          sender: this.selfHandle,
        });
      } catch {
        // listener failures must not break dispatch
      }
    }
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
    }
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
    this.onError('offline', {
      reason: 'send_failed_queued',
      appSlug: app.appSlug,
      cause: (cause as Error)?.message ?? 'unknown',
    });
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
