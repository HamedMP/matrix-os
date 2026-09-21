/** Filesystem driver for owner-home collaboration resources. Catalog IDs, never paths, reach this boundary. */
import { randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { isSafeCollaborationRelativePath } from "@matrix-os/contracts";
import { ResourceCatalogError } from "./resource-catalog.js";
import type { CollaborationResourceDriver } from "./resource-actions.js";

const MAX_STREAM_BYTES = 256 * 1024 * 1024;
const TEMP_TTL_MS = 60 * 60 * 1_000;
const TEMP_SWEEP_INTERVAL_MS = 30 * 60 * 1_000;
const MAX_TRACKED_DIRECTORIES = 128;
const DENIED_HOME_ROOTS = new Set(["system", "agents", "data"]);
type Namespace = { ownerId: string; projectId: string | null };

function inside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
function forbiddenHomePath(path: string): boolean {
  const first = path.split("/")[0] ?? "";
  return first.startsWith(".") || DENIED_HOME_ROOTS.has(first);
}
function missing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
function contentType(path: string): string {
  const extension = path.split(".").at(-1)?.toLowerCase();
  switch (extension) {
    case "js": return "text/javascript";
    case "css": return "text/css";
    case "svg": return "image/svg+xml";
    case "png": return "image/png";
    case "jpg": case "jpeg": return "image/jpeg";
    case "webp": return "image/webp";
    case "html": return "text/html";
    default: return "application/octet-stream";
  }
}

export function createOwnerResourceDriver(options: {
  homePath: string;
  resolveProjectWorkingDirectory(ownerId: string, projectId: string): Promise<string | null>;
  resolveAppAssetRoot(ownerId: string, projectId: string | null, appId: string): Promise<string | null>;
}): CollaborationResourceDriver & { sweepTemp(): Promise<number>; close(): void } {
  const homeRoot = resolve(options.homePath);
  // Bounded LRU of directories where this process placed an atomic write temp.
  const trackedDirectories = new Set<string>();
  function trackDirectory(path: string): void {
    trackedDirectories.delete(path);
    trackedDirectories.add(path);
    if (trackedDirectories.size > MAX_TRACKED_DIRECTORIES) {
      trackedDirectories.delete(trackedDirectories.values().next().value!);
    }
  }
  async function sweepTemp(): Promise<number> {
    let removed = 0;
    for (const directory of trackedDirectories) {
      let names: string[];
      try { names = await readdir(directory); } catch (error: unknown) {
        console.warn("[collaboration-resources] temp directory unavailable", error instanceof Error ? error.name : "UnknownError");
        continue;
      }
      for (const name of names.slice(0, 1_000)) {
        if (!/^\.matrix-upload-[0-9a-f-]{36}$/.test(name)) continue;
        const path = resolve(directory, name);
        try {
          const entry = await lstat(path);
          if (entry.isSymbolicLink() || !entry.isFile() || Date.now() - entry.mtimeMs < TEMP_TTL_MS) continue;
          await rm(path);
          removed += 1;
        } catch (error: unknown) {
          if (!missing(error)) console.warn("[collaboration-resources] temp sweep failed", error instanceof Error ? error.name : "UnknownError");
        }
      }
    }
    return removed;
  }
  const timer = setInterval(() => { void sweepTemp(); }, TEMP_SWEEP_INTERVAL_MS);
  timer.unref();

  async function root(input: Namespace): Promise<string> {
    const candidate = input.projectId === null
      ? homeRoot
      : await options.resolveProjectWorkingDirectory(input.ownerId, input.projectId);
    if (!candidate || !isAbsolute(candidate)) throw new ResourceCatalogError("unavailable");
    try {
      const entry = await lstat(candidate);
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw new ResourceCatalogError("unavailable");
      return await realpath(candidate);
    } catch (error: unknown) {
      if (error instanceof ResourceCatalogError) throw error;
      if (missing(error)) throw new ResourceCatalogError("not_found");
      throw new ResourceCatalogError("unavailable");
    }
  }

  async function target(input: Namespace & { path: string }, allowMissing: boolean): Promise<string> {
    if (!isSafeCollaborationRelativePath(input.path) || (input.projectId === null && forbiddenHomePath(input.path))) {
      throw new ResourceCatalogError("forbidden");
    }
    const base = await root(input);
    const candidate = resolve(base, input.path);
    if (!inside(base, candidate) || candidate === base) throw new ResourceCatalogError("forbidden");
    let current = base;
    const pieces = input.path.split("/");
    for (let index = 0; index < pieces.length; index += 1) {
      current = resolve(current, pieces[index]!);
      try {
        const entry = await lstat(current);
        if (entry.isSymbolicLink() || (index < pieces.length - 1 && !entry.isDirectory())) {
          throw new ResourceCatalogError("forbidden");
        }
      } catch (error: unknown) {
        if (error instanceof ResourceCatalogError) throw error;
        if (missing(error) && allowMissing && index === pieces.length - 1) return candidate;
        if (missing(error)) throw new ResourceCatalogError("not_found");
        throw new ResourceCatalogError("unavailable");
      }
    }
    return candidate;
  }

  async function readFile(input: Namespace & { path: string }) {
    const path = await target(input, false);
    let handle;
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = await handle.stat();
      if (!info.isFile() || info.size > MAX_STREAM_BYTES) throw new ResourceCatalogError("unavailable");
      const size = info.size;
      const stream = Readable.toWeb(handle.createReadStream({ autoClose: true })) as ReadableStream<Uint8Array>;
      return { stream, size, contentType: contentType(path) };
    } catch (error: unknown) {
      await handle?.close().catch((closeError: unknown) => {
        console.warn("[collaboration-resources] file handle close failed", closeError instanceof Error ? closeError.name : "UnknownError");
      });
      if (error instanceof ResourceCatalogError) throw error;
      if (missing(error)) throw new ResourceCatalogError("not_found");
      throw new ResourceCatalogError("unavailable");
    }
  }

  async function writeFile(input: Namespace & { path: string; content: Uint8Array }) {
    if (input.content.byteLength > MAX_STREAM_BYTES) throw new ResourceCatalogError("invalid");
    const destination = await target(input, true);
    trackDirectory(dirname(destination));
    const temp = resolve(dirname(destination), `.matrix-upload-${randomUUID()}`);
    let written = false;
    try {
      const file = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      try {
        await file.writeFile(input.content);
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temp, destination);
      written = true;
    } catch (error: unknown) {
      if (error instanceof ResourceCatalogError) throw error;
      if (missing(error)) throw new ResourceCatalogError("not_found");
      throw new ResourceCatalogError("unavailable");
    } finally {
      if (!written) await rm(temp, { force: true }).catch((error: unknown) => {
        console.warn("[collaboration-resources] temp cleanup failed", error instanceof Error ? error.name : "UnknownError");
      });
    }
  }

  return {
    sweepTemp,
    close: () => clearInterval(timer),
    read: readFile,
    write: writeFile,
    async remove(input) {
      const path = await target(input, false);
      try {
        await rm(path, { recursive: input.kind === "folder", force: false });
      } catch (error: unknown) {
        if (missing(error)) throw new ResourceCatalogError("not_found");
        throw new ResourceCatalogError("unavailable");
      }
    },
    async rename(input) {
      const from = await target({ ...input, path: input.from }, false);
      const to = await target({ ...input, path: input.to }, true);
      try {
        await stat(to);
        throw new ResourceCatalogError("conflict");
      } catch (error: unknown) {
        if (!missing(error)) {
          if (error instanceof ResourceCatalogError) throw error;
          throw new ResourceCatalogError("unavailable");
        }
      }
      try {
        await rename(from, to);
      } catch (error: unknown) {
        if (missing(error)) throw new ResourceCatalogError("not_found");
        throw new ResourceCatalogError("unavailable");
      }
    },
    async mkdir(input) {
      const path = await target(input, true);
      try {
        await mkdir(path, { recursive: false, mode: 0o700 });
      } catch (error: unknown) {
        if (missing(error)) throw new ResourceCatalogError("not_found");
        throw new ResourceCatalogError("unavailable");
      }
    },
    async fingerprint(input) {
      await target(input, false);
      return randomUUID();
    },
    async readAppAsset(input) {
      const assetRoot = await options.resolveAppAssetRoot(input.ownerId, input.projectId, input.appId);
      if (!assetRoot || !isAbsolute(assetRoot)) throw new ResourceCatalogError("unavailable");
      const asset = await readFileFromAssetRoot(assetRoot, input.assetPath);
      return { ...asset, contentType: contentType(input.assetPath) };
    },
  };
}

async function readFileFromAssetRoot(rootPath: string, assetPath: string) {
  if (!isSafeCollaborationRelativePath(assetPath) || assetPath.split("/").some((part) => part.startsWith("."))) {
    throw new ResourceCatalogError("forbidden");
  }
  let base: string;
  try {
    const entry = await lstat(rootPath);
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new ResourceCatalogError("unavailable");
    base = await realpath(rootPath);
  } catch (error: unknown) {
    if (error instanceof ResourceCatalogError) throw error;
    throw new ResourceCatalogError("unavailable");
  }
  const path = resolve(base, assetPath);
  if (!inside(base, path)) throw new ResourceCatalogError("forbidden");
  let current = base;
  for (const component of assetPath.split("/")) {
    current = resolve(current, component);
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new ResourceCatalogError("forbidden");
    } catch (error: unknown) {
      if (error instanceof ResourceCatalogError) throw error;
      if (missing(error)) throw new ResourceCatalogError("not_found");
      throw new ResourceCatalogError("unavailable");
    }
  }
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_STREAM_BYTES) throw new ResourceCatalogError("unavailable");
    return { size: info.size, stream: Readable.toWeb(handle.createReadStream({ autoClose: true })) as ReadableStream<Uint8Array> };
  } catch (error: unknown) {
    await handle?.close().catch((closeError: unknown) => {
        console.warn("[collaboration-resources] file handle close failed", closeError instanceof Error ? closeError.name : "UnknownError");
      });
    if (error instanceof ResourceCatalogError) throw error;
    if (missing(error)) throw new ResourceCatalogError("not_found");
    throw new ResourceCatalogError("unavailable");
  }
}
