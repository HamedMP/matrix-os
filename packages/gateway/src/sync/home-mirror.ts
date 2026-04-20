import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { watch, type FSWatcher } from "chokidar";
import {
  applyCommitToManifest,
  readManifest,
  writeManifest,
  type ManifestDb,
  type ManifestDbExecutor,
} from "./manifest.js";
import { resolveWithinPrefix } from "./path-validation.js";
import {
  buildFileKey,
  type R2Client,
} from "./r2-client.js";
import type { Manifest, ManifestEntry } from "./types.js";
import type { PeerRegistry, SyncPeerConnection } from "./ws-events.js";

const RECENT_WRITE_CAP = 50_000;
const DEFAULT_MAX_PUSH_BYTES = 100 * 1024 * 1024;

// Folders we never push -- big build outputs, transient state, secrets,
// or things that would loop on themselves (the home dir itself when run
// from inside it). Keep this conservative; the user can override with a
// `.syncignore` in their home root.
const DEFAULT_IGNORE_DIRS = new Set([
  "node_modules",
  ".next",
  ".git",
  ".matrixos",
  "dist",
  "build",
  ".cache",
  ".turbo",
  "coverage",
  ".pnpm-store",
  ".vscode",
  "tmp",
]);

const DEFAULT_IGNORE_PATTERNS = [
  /\.log$/i,
  /\.tmp$/i,
  /^\.DS_Store$/,
  /\.env(\..+)?$/,
];

export interface HomeMirrorConfig {
  r2: R2Client;
  manifestDb: ManifestDb;
  homeRoot: string; // /home/matrixos/home
  userId: string; // handle, e.g. "alice"
  peerId: string; // gateway-internal peer id, e.g. `gateway-${handle}`
  /**
   * Peer registry to subscribe to `sync:change` broadcasts from other peers.
   * When set, the mirror registers itself as a virtual peer whose "send()"
   * handler pulls files from R2 into the container home. Omit to disable
   * the subscribe side (startup-pull-only mode).
   */
  peerRegistry?: PeerRegistry;
  logger?: { info: (msg: string, ...args: unknown[]) => void; error: (msg: string, ...args: unknown[]) => void };
  /** Override the path-segment match list. Used by tests. */
  extraIgnoreDirs?: Iterable<string>;
  /** Skip local auto-push for files larger than this many bytes. */
  maxPushBytes?: number;
}

export interface HomeMirror {
  start(): Promise<void>;
  stop(): Promise<void>;
}

function createSerialQueue(
  onError: (err: unknown) => void,
): <T>(fn: () => Promise<T>) => Promise<T> {
  let chain: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const next = chain.then(fn, fn);
    chain = next.catch((err: unknown) => {
      onError(err);
      return undefined;
    });
    return next;
  };
}

function isIgnored(relPath: string, extraDirs?: Set<string>): boolean {
  // Treat the home root itself ("") as NOT ignored -- otherwise chokidar
  // refuses to descend into it. Only ignore actual entries.
  if (!relPath || relPath === ".") return false;
  const segments = relPath.split(sep);
  for (const seg of segments) {
    if (DEFAULT_IGNORE_DIRS.has(seg)) return true;
    if (extraDirs?.has(seg)) return true;
  }
  const last = segments[segments.length - 1] ?? "";
  return DEFAULT_IGNORE_PATTERNS.some((p) => p.test(last));
}

function hashFileStream(absPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    const s = createReadStream(absPath);
    s.on("data", (chunk) => h.update(chunk));
    s.on("end", () => resolve(`sha256:${h.digest("hex")}`));
    s.on("error", reject);
  });
}

function hashBuffer(buf: Buffer): string {
  return `sha256:${createHash("sha256").update(buf).digest("hex")}`;
}

function normalizeRelativePath(relPath: string): string {
  const checked = resolveWithinPrefix("home-mirror", relPath);
  if (!checked.valid) {
    throw new Error(`invalid path: ${checked.reason}`);
  }
  return relPath.replace(/\/+/g, "/").replace(/\/$/, "");
}

// AWS SDK v3 returns its own stream type with `transformToByteArray()`,
// NOT a Web ReadableStream -- calling .getReader() throws "is not a function".
// Match what manifest.ts does for body decoding (transformToString fallback).
async function streamToBuffer(body: unknown): Promise<Buffer> {
  const anyBody = body as {
    transformToByteArray?: () => Promise<Uint8Array>;
    getReader?: () => ReadableStreamDefaultReader<Uint8Array>;
  };
  if (typeof anyBody.transformToByteArray === "function") {
    return Buffer.from(await anyBody.transformToByteArray());
  }
  if (typeof anyBody.getReader === "function") {
    const reader = anyBody.getReader();
    const chunks: Uint8Array[] = [];
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
    return Buffer.concat(chunks);
  }
  return Buffer.from(await new Response(body as BodyInit).arrayBuffer());
}

export function createHomeMirror(config: HomeMirrorConfig): HomeMirror {
  const log = config.logger ?? {
    info: (msg, ...rest) => console.log(`[home-mirror] ${msg}`, ...rest),
    error: (msg, ...rest) => console.error(`[home-mirror] ${msg}`, ...rest),
  };
  const extraIgnore = config.extraIgnoreDirs
    ? new Set(config.extraIgnoreDirs)
    : undefined;
  const maxPushBytes = config.maxPushBytes ?? DEFAULT_MAX_PUSH_BYTES;

  let watcher: FSWatcher | null = null;

  // Serial commit chain: home-mirror updates manifest in-process, but
  // multiple writes still need to read-modify-write the version counter.
  const enqueue = createSerialQueue((err) => {
    log.error(
      "serial queue task failed:",
      err instanceof Error ? err.message : String(err),
    );
  });

  // Suppress watcher events for paths we just downloaded ourselves.
  // chokidar will emit `add`/`change` for files we wrote during initial
  // pull; without this guard we'd round-trip every download into an upload.
  const recentlyWritten = new Map<string, number>();
  const SUPPRESS_MS = 5_000;
  const markWritten = (relPath: string) => {
    recentlyWritten.set(relPath, Date.now());
    // Keep enough entries to cover an initial pull of the full manifest.
    if (recentlyWritten.size > RECENT_WRITE_CAP) {
      const oldest = recentlyWritten.keys().next().value;
      if (oldest !== undefined) recentlyWritten.delete(oldest);
    }
  };
  const wasJustWritten = (relPath: string): boolean => {
    const ts = recentlyWritten.get(relPath);
    if (ts === undefined) return false;
    if (Date.now() - ts > SUPPRESS_MS) {
      recentlyWritten.delete(relPath);
      return false;
    }
    return true;
  };

  const store = { r2: config.r2, db: config.manifestDb };

  async function withManifestLock<T>(
    fn: (lockedStore: typeof store & { dbExecutor: ManifestDbExecutor }) => Promise<T>,
  ): Promise<T> {
    return config.manifestDb.withAdvisoryLock(config.userId, async (dbExecutor) =>
      fn({ ...store, dbExecutor }),
    );
  }

  // Broadcast a sync:change to every registered peer EXCEPT this mirror so
  // the laptop daemon sees container edits in real-time. Without this the
  // laptop only learns about them on its own next commit (via the new
  // manifestVersion) or a full reconnect -- which breaks the "edit in
  // container, see it on laptop ~5s later" UX.
  function broadcastChange(
    file: { path: string; hash: string; size: number; action: "add" | "update" | "delete" },
    manifestVersion: number,
  ): void {
    if (!config.peerRegistry) return;
    config.peerRegistry.broadcastChange(config.userId, config.peerId, {
      type: "sync:change",
      files: [file],
      peerId: config.peerId,
      manifestVersion,
    });
  }

  async function pushFile(relPath: string): Promise<void> {
    const absPath = join(config.homeRoot, relPath);

    await enqueue(async () => {
      let fileStat;
      try {
        fileStat = await stat(absPath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
        throw err;
      }
      if (!fileStat.isFile()) return;
      if (fileStat.size > maxPushBytes) {
        log.error(
          `skipping push for ${relPath}: file exceeds ${maxPushBytes} bytes`,
        );
        return;
      }

      await withManifestLock(async (lockedStore) => {
        const existing = await readManifest(lockedStore, config.userId);
        const body = await readFile(absPath);
        const hash = hashBuffer(body);

        const currentEntry = existing.manifest.files[relPath];
        if (currentEntry?.hash === hash && !currentEntry.deleted) {
          // Already in manifest with same hash -- skip the upload.
          return;
        }

        const key = buildFileKey(config.userId, relPath);
        await config.r2.putObject(key, body);

        const action = currentEntry ? "update" : "add";
        const next: Manifest = applyCommitToManifest(
          existing.manifest,
          [{ path: relPath, hash, size: body.length, action }],
          config.peerId,
        );

        const newVersion = existing.manifestVersion + 1;
        await writeManifest(lockedStore, config.userId, next, newVersion);
        broadcastChange({ path: relPath, hash, size: body.length, action }, newVersion);
        log.info(`pushed ${relPath} (${body.length}B)`);
      });
    });
  }

  async function pushDelete(relPath: string): Promise<void> {
    await enqueue(async () => {
      await withManifestLock(async (lockedStore) => {
        const existing = await readManifest(lockedStore, config.userId);
        const entry = existing.manifest.files[relPath];
        if (!entry || entry.deleted) return;

        const next: Manifest = applyCommitToManifest(
          existing.manifest,
          [{ path: relPath, hash: entry.hash, size: 0, action: "delete" }],
          config.peerId,
        );

        const newVersion = existing.manifestVersion + 1;
        await writeManifest(lockedStore, config.userId, next, newVersion);

        const key = buildFileKey(config.userId, relPath);
        await config.r2.deleteObject(key).catch((err: unknown) => {
          log.error(
            `delete blob failed for ${relPath}:`,
            err instanceof Error ? err.message : String(err),
          );
        });
        broadcastChange(
          { path: relPath, hash: entry.hash, size: 0, action: "delete" },
          newVersion,
        );
        log.info(`deleted ${relPath}`);
      });
    });
  }

  async function pullFile(relPath: string, entry: ManifestEntry): Promise<void> {
    const safeRelPath = normalizeRelativePath(relPath);
    const absPath = join(config.homeRoot, safeRelPath);
    try {
      const localStat = await stat(absPath);
      if (localStat.isFile()) {
        const localHash = await hashFileStream(absPath);
        if (localHash === entry.hash) return;
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }

    const key = buildFileKey(config.userId, safeRelPath);
    const obj = await config.r2.getObject(key);
    if (!obj.body) return;

    const buf = await streamToBuffer(obj.body);
    await mkdir(dirname(absPath), { recursive: true });
    markWritten(safeRelPath);
    await writeFile(absPath, buf);
    log.info(`pulled ${safeRelPath} (${buf.length}B)`);
  }

  async function initialPull(): Promise<void> {
    const existing = await readManifest(store, config.userId);
    const files = existing.manifest.files ?? {};
    let pulled = 0;
    for (const [relPath, entry] of Object.entries(files)) {
      if (!entry.hash || entry.deleted || isIgnored(relPath, extraIgnore)) continue;
      try {
        await pullFile(relPath, entry);
        pulled++;
      } catch (err) {
        log.error(`pull failed for ${relPath}:`, (err as Error).message);
      }
    }
    if (pulled > 0) log.info(`initial pull: ${pulled} files`);
  }

  async function pullDelete(relPath: string): Promise<void> {
    const safeRelPath = normalizeRelativePath(relPath);
    const absPath = join(config.homeRoot, safeRelPath);
    try {
      await stat(absPath); // throws ENOENT if already gone
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    markWritten(safeRelPath);
    await unlink(absPath);
    log.info(`pulled delete ${safeRelPath}`);
  }

  // Handle a `sync:change` broadcast from another peer. Applies to each file
  // in the message: downloads the new content (or deletes locally). The
  // recentlyWritten guard suppresses the chokidar echo so we don't push it
  // back up to R2. Errors are logged per-file; one bad file doesn't stop
  // the rest. Returns after all files have been processed.
  async function handleRemoteChange(msg: {
    files?: Array<{ path: string; hash: string; size: number; action?: string }>;
    peerId?: string;
  }): Promise<void> {
    const files = msg.files ?? [];
    for (const f of files) {
      if (!f.path || isIgnored(f.path, extraIgnore)) continue;
      try {
        if (f.action === "delete") {
          await pullDelete(f.path);
        } else {
          await pullFile(f.path, {
            hash: f.hash,
            size: f.size,
            mtime: Date.now(),
            peerId: msg.peerId ?? "remote",
            version: 0,
          } as ManifestEntry);
        }
      } catch (err) {
        log.error(`remote-change failed for ${f.path}:`, (err as Error).message);
      }
    }
  }

  // A fake WS connection the peer registry can "send" broadcasts through.
  // readyState=1 so the registry doesn't skip us; each send() is parsed as
  // a sync event and dispatched to handleRemoteChange. Ignoring non-change
  // messages keeps us compatible with future broadcast types (peer-join etc.)
  // without blowing up on unknown `type`.
  function createSubscriberConnection(): SyncPeerConnection {
    return {
      readyState: 1,
      send(data: string) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(data);
        } catch (err: unknown) {
          log.error(
            "ignored malformed peer broadcast:",
            err instanceof Error ? err.message : String(err),
          );
          return;
        }
        const msg = parsed as { type?: string };
        if (msg?.type !== "sync:change") return;
        // Fire-and-forget; the registry's send is synchronous so we can't
        // await here. Errors are logged inside handleRemoteChange.
        enqueue(() => handleRemoteChange(msg as Parameters<typeof handleRemoteChange>[0]))
          .catch((err) => log.error("remote-change enqueue failed:", (err as Error).message));
      },
    };
  }

  return {
    async start(): Promise<void> {
      await mkdir(config.homeRoot, { recursive: true });
      await initialPull();

      // Register with the peer registry BEFORE starting the watcher. Any
      // commits that land while we're catching up will queue through
      // handleRemoteChange and run serially via `enqueue`.
      if (config.peerRegistry) {
        config.peerRegistry.registerPeer(
          config.userId,
          {
            peerId: config.peerId,
            hostname: "gateway",
            platform: "linux",
            clientVersion: "home-mirror",
          },
          createSubscriberConnection(),
        );
        log.info(`home mirror subscribed to broadcasts as ${config.peerId}`);
      }

      watcher = watch(config.homeRoot, {
        persistent: true,
        ignoreInitial: false,
        awaitWriteFinish: { stabilityThreshold: 250, pollInterval: 100 },
        ignored: (absPath) => {
          const rel = relative(config.homeRoot, absPath);
          return isIgnored(rel, extraIgnore);
        },
      });

      watcher.on("add", (absPath) => {
        const rel = relative(config.homeRoot, absPath);
        if (wasJustWritten(rel)) return;
        pushFile(rel).catch((err) => log.error(`push failed for ${rel}: ${err.message}`));
      });
      watcher.on("change", (absPath) => {
        const rel = relative(config.homeRoot, absPath);
        if (wasJustWritten(rel)) return;
        pushFile(rel).catch((err) => log.error(`push failed for ${rel}: ${err.message}`));
      });
      watcher.on("unlink", (absPath) => {
        const rel = relative(config.homeRoot, absPath);
        if (wasJustWritten(rel)) return;
        pushDelete(rel).catch((err) => log.error(`delete failed for ${rel}: ${err.message}`));
      });

      log.info(`home mirror started for ${config.homeRoot} (peer=${config.peerId})`);
    },

    async stop(): Promise<void> {
      if (watcher) {
        await watcher.close();
        watcher = null;
      }
      if (config.peerRegistry) {
        config.peerRegistry.removePeer(config.userId, config.peerId);
      }
    },
  };
}
