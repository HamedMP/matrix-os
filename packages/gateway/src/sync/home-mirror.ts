import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { watch, type FSWatcher } from "chokidar";
import {
  applyCommitToManifest,
  readManifest,
  writeManifest,
  type ManifestDb,
} from "./manifest.js";
import {
  buildFileKey,
  type R2Client,
} from "./r2-client.js";
import type { Manifest, ManifestEntry } from "./types.js";

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
  logger?: { info: (msg: string, ...args: unknown[]) => void; error: (msg: string, ...args: unknown[]) => void };
  /** Override the path-segment match list. Used by tests. */
  extraIgnoreDirs?: Iterable<string>;
}

export interface HomeMirror {
  start(): Promise<void>;
  stop(): Promise<void>;
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

  let watcher: FSWatcher | null = null;

  // Serial commit chain: home-mirror updates manifest in-process, but
  // multiple writes still need to read-modify-write the version counter.
  let chain: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = chain.then(fn, fn);
    chain = next.catch(() => undefined);
    return next;
  };

  // Suppress watcher events for paths we just downloaded ourselves.
  // chokidar will emit `add`/`change` for files we wrote during initial
  // pull; without this guard we'd round-trip every download into an upload.
  const recentlyWritten = new Map<string, number>();
  const SUPPRESS_MS = 5_000;
  const markWritten = (relPath: string) => {
    recentlyWritten.set(relPath, Date.now());
    // Cap the map; oldest entry evicted if it grows past 1000.
    if (recentlyWritten.size > 1000) {
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

  async function pushFile(relPath: string): Promise<void> {
    const absPath = join(config.homeRoot, relPath);
    let fileStat;
    try {
      fileStat = await stat(absPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    if (!fileStat.isFile()) return;

    const hash = await hashFileStream(absPath);

    await enqueue(async () => {
      const existing = await readManifest(store, config.userId);

      const currentEntry = existing.manifest.files[relPath];
      if (currentEntry?.hash === hash && !currentEntry.deleted) {
        // Already in manifest with same hash -- skip the upload.
        return;
      }

      const body = await readFile(absPath);
      const key = buildFileKey(config.userId, relPath);
      await config.r2.putObject(key, body);

      const action = currentEntry ? "update" : "add";
      const next: Manifest = applyCommitToManifest(
        existing.manifest,
        [{ path: relPath, hash, size: fileStat.size, action }],
        config.peerId,
      );

      await writeManifest(store, config.userId, next, existing.manifestVersion + 1);
      log.info(`pushed ${relPath} (${fileStat.size}B)`);
    });
  }

  async function pushDelete(relPath: string): Promise<void> {
    await enqueue(async () => {
      const existing = await readManifest(store, config.userId);
      const entry = existing.manifest.files[relPath];
      if (!entry || entry.deleted) return;

      const next: Manifest = applyCommitToManifest(
        existing.manifest,
        [{ path: relPath, hash: entry.hash, size: 0, action: "delete" }],
        config.peerId,
      );

      await writeManifest(store, config.userId, next, existing.manifestVersion + 1);

      const key = buildFileKey(config.userId, relPath);
      await config.r2.deleteObject(key).catch(() => undefined);
      log.info(`deleted ${relPath}`);
    });
  }

  async function pullFile(relPath: string, entry: ManifestEntry): Promise<void> {
    const absPath = join(config.homeRoot, relPath);
    try {
      const localStat = await stat(absPath);
      if (localStat.isFile()) {
        const localHash = await hashFileStream(absPath);
        if (localHash === entry.hash) return;
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }

    const key = buildFileKey(config.userId, relPath);
    const obj = await config.r2.getObject(key);
    if (!obj.body) return;

    const buf = await streamToBuffer(obj.body);
    await mkdir(dirname(absPath), { recursive: true });
    markWritten(relPath);
    await writeFile(absPath, buf);
    log.info(`pulled ${relPath} (${buf.length}B)`);
  }

  async function initialPull(): Promise<void> {
    const existing = await readManifest(store, config.userId);
    const files = existing.manifest.files ?? {};
    let pulled = 0;
    for (const [relPath, entry] of Object.entries(files)) {
      if (!entry.hash || isIgnored(relPath, extraIgnore)) continue;
      try {
        await pullFile(relPath, entry);
        pulled++;
      } catch (err) {
        log.error(`pull failed for ${relPath}:`, (err as Error).message);
      }
    }
    if (pulled > 0) log.info(`initial pull: ${pulled} files`);
  }

  return {
    async start(): Promise<void> {
      await mkdir(config.homeRoot, { recursive: true });
      await initialPull();

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
        pushFile(rel).catch((err) => log.error(`push failed for ${rel}:`, err.message));
      });
      watcher.on("change", (absPath) => {
        const rel = relative(config.homeRoot, absPath);
        if (wasJustWritten(rel)) return;
        pushFile(rel).catch((err) => log.error(`push failed for ${rel}:`, err.message));
      });
      watcher.on("unlink", (absPath) => {
        const rel = relative(config.homeRoot, absPath);
        if (wasJustWritten(rel)) return;
        pushDelete(rel).catch((err) => log.error(`delete failed for ${rel}:`, err.message));
      });

      log.info(`home mirror started for ${config.homeRoot} (peer=${config.peerId})`);
    },

    async stop(): Promise<void> {
      if (watcher) {
        await watcher.close();
        watcher = null;
      }
    },
  };
}
