import {
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join, posix, resolve } from "node:path";
import { FileManagementPathSchema } from "./file-management/contracts.js";
import { getFileEntryCapabilities } from "./file-management/policy.js";
import {
  moveFileNoReplace,
  type NoReplaceFileMoveCapability,
} from "./file-ops.js";
import {
  resolveExistingFileApiPath,
  resolveWithinHome,
  resolveWritableFileApiPath,
} from "./path-security.js";

interface TrashManifestEntry {
  name: string;
  originalPath: string;
  deletedAt: string;
  trashPath: string;
}

export interface TrashListEntry extends TrashManifestEntry {
  size?: number;
  type: "file" | "directory";
}

const DEFAULT_MAX_ACTIVE_HOMES = 128;
const DEFAULT_MAX_PENDING_OPERATIONS = 512;
const MAX_TRASH_NAME_CANDIDATES = 100;

export interface TrashManifestIo {
  writeTemporary(path: string, contents: string): Promise<void>;
  replaceManifest(temporaryPath: string, manifestPath: string): Promise<void>;
  cleanupTemporary(path: string): Promise<void>;
}

export interface TrashDeleteDependencies {
  manifestQueue?: TrashManifestQueue;
  requestId?: string;
  moveCapability?: NoReplaceFileMoveCapability;
  manifestIo?: Partial<TrashManifestIo>;
}

export class TrashManifestQueueCapacityError extends Error {
  readonly code = "operation_unavailable";

  constructor() {
    super("Trash operation is temporarily unavailable");
    this.name = "TrashManifestQueueCapacityError";
  }
}

export class TrashManifestQueueClosedError extends Error {
  readonly code = "operation_unavailable";

  constructor() {
    super("Trash operation is unavailable");
    this.name = "TrashManifestQueueClosedError";
  }
}

export class TrashManifestUnavailableError extends Error {
  readonly code = "failed";

  constructor() {
    super("Trash manifest is unavailable");
    this.name = "TrashManifestUnavailableError";
  }
}

export class TrashManifestQueue {
  private readonly maxHomes: number;
  private readonly maxPending: number;
  private readonly homes = new Map<string, Promise<void>>();
  private pending = 0;
  private closed = false;

  constructor(options: { maxHomes?: number; maxPending?: number } = {}) {
    this.maxHomes = options.maxHomes ?? DEFAULT_MAX_ACTIVE_HOMES;
    this.maxPending = options.maxPending ?? DEFAULT_MAX_PENDING_OPERATIONS;
    if (!Number.isSafeInteger(this.maxHomes) || this.maxHomes < 1) {
      throw new TypeError("maxHomes must be a positive integer");
    }
    if (!Number.isSafeInteger(this.maxPending) || this.maxPending < 1) {
      throw new TypeError("maxPending must be a positive integer");
    }
  }

  run<T>(homePath: string, operation: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new TrashManifestQueueClosedError());
    const key = resolve(homePath);
    const previous = this.homes.get(key);
    if (this.pending >= this.maxPending || (!previous && this.homes.size >= this.maxHomes)) {
      return Promise.reject(new TrashManifestQueueCapacityError());
    }

    this.pending += 1;
    const result = (previous ?? Promise.resolve()).then(operation, operation);
    const idle = result.then(() => undefined, () => undefined);
    this.homes.set(key, idle);
    return result.finally(() => {
      this.pending -= 1;
      if (this.homes.get(key) === idle) this.homes.delete(key);
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.allSettled([...this.homes.values()]);
    this.homes.clear();
    this.pending = 0;
  }
}

export async function fileDelete(
  homePath: string,
  requestedPath: string,
  dependencies: TrashDeleteDependencies = {},
): Promise<{ ok: boolean; trashPath?: string; error?: string; status?: number }> {
  const authorization = authorizeTrashSource(homePath, requestedPath);
  if (authorization) return authorization;

  try {
    return await serialize(dependencies.manifestQueue, homePath, async () => {
      const trashDir = join(homePath, ".trash");
      await mkdir(trashDir, { recursive: true });
      await assertTrashDirectory(trashDir, false);
      const manifest = await readManifest(trashDir);

      if (!existsSync(resolveWithinHome(homePath, requestedPath)!)) {
        return { ok: false, error: "Not found", status: 404 };
      }
      const source = resolveExistingFileApiPath(homePath, requestedPath);
      if (!source) return { ok: false, error: "Invalid path" };
      const sourceStats = await lstat(source);
      if (!sourceStats.isFile() && !sourceStats.isDirectory()) {
        return { ok: false, error: "Invalid path" };
      }

      const name = basename(source);
      for (const trashName of trashNameCandidates(name)) {
        if (isReservedTrashName(trashName)) continue;
        const trashPath = `.trash/${trashName}`;
        const moveResult = await moveFileNoReplace(homePath, requestedPath, trashPath, {
          moveCapability: dependencies.moveCapability,
          requestId: dependencies.requestId,
        });
        if (moveResult.ok) {
          manifest.push({
            name,
            originalPath: requestedPath,
            deletedAt: new Date().toISOString(),
            trashPath,
          });
          await writeManifest(trashDir, manifest, dependencies.manifestIo);
          return { ok: true, trashPath };
        }
        if (moveResult.code === "destination_conflict") continue;
        if (moveResult.code === "source_missing") {
          return { ok: false, error: "Not found", status: 404 };
        }
        if (moveResult.code === "invalid_path") {
          return { ok: false, error: "Invalid path" };
        }
        return { ok: false, error: "Trash operation failed", status: 500 };
      }
      return { ok: false, error: "Trash operation failed", status: 409 };
    });
  } catch (error: unknown) {
    const requestContext = dependencies.requestId ? ` for request ${dependencies.requestId}` : "";
    console.error(`[trash] Delete failed${requestContext}:`, safeLogError(error));
    return { ok: false, error: "Trash operation failed", status: 500 };
  }
}

export async function trashList(
  homePath: string,
  manifestQueue?: TrashManifestQueue,
): Promise<{ entries: TrashListEntry[] }> {
  return serialize(manifestQueue, homePath, async () => {
    const trashDir = join(homePath, ".trash");
    const manifest = await readManifest(trashDir);
    const entries: TrashListEntry[] = [];
    for (const entry of manifest) {
      const fullPath = resolveTrashEntry(homePath, entry.trashPath);
      if (!fullPath) continue;
      try {
        const stats = await lstat(fullPath);
        if (stats.isSymbolicLink() || (!stats.isFile() && !stats.isDirectory())) continue;
        entries.push({
          ...entry,
          size: stats.isFile() ? stats.size : undefined,
          type: stats.isDirectory() ? "directory" : "file",
        });
      } catch (error: unknown) {
        if (!isErrno(error, "ENOENT")) console.warn("[trash] Could not inspect trash entry:", safeLogError(error));
      }
    }
    return { entries };
  });
}

export async function trashRestore(
  homePath: string,
  trashPath: string,
  manifestQueue?: TrashManifestQueue,
): Promise<{ ok: boolean; restoredTo?: string; error?: string; status?: number }> {
  const resolvedTrash = resolveTrashEntry(homePath, trashPath);
  if (!resolvedTrash) return { ok: false, error: "Invalid trash path" };
  if (!existsSync(resolvedTrash)) return { ok: false, error: "Not found in trash", status: 404 };

  try {
    return await serialize(manifestQueue, homePath, async () => {
      const trashDir = join(homePath, ".trash");
      const manifest = await readManifest(trashDir);
      const entryIndex = manifest.findIndex((entry) => entry.trashPath === trashPath);
      if (entryIndex === -1) return { ok: false, error: "Not found in trash", status: 404 };

      const entry = manifest[entryIndex];
      const capabilities = getFileEntryCapabilities(homePath, entry.originalPath);
      if (!capabilities.canTrash) {
        return { ok: false, error: "Cannot restore to a protected path", status: 403 };
      }
      const restorePath = resolveWritableFileApiPath(homePath, entry.originalPath);
      if (!restorePath) return { ok: false, error: "Invalid restore path" };
      if (existsSync(restorePath)) {
        return { ok: false, error: "Destination already exists", status: 409 };
      }

      await mkdir(dirname(restorePath), { recursive: true });
      await rename(resolvedTrash, restorePath);
      manifest.splice(entryIndex, 1);
      await writeManifest(trashDir, manifest);
      return { ok: true, restoredTo: entry.originalPath };
    });
  } catch (error: unknown) {
    console.error("[trash] Restore failed:", safeLogError(error));
    return { ok: false, error: "Trash operation failed", status: 500 };
  }
}

export async function trashEmpty(
  homePath: string,
  manifestQueue?: TrashManifestQueue,
): Promise<{ ok: boolean; deleted: number }> {
  return serialize(manifestQueue, homePath, async () => {
    const trashDir = join(homePath, ".trash");
    const manifest = await readManifest(trashDir);
    if (manifest.length === 0) return { ok: true, deleted: 0 };

    let deleted = 0;
    const retained: TrashManifestEntry[] = [];
    for (const entry of manifest) {
      const fullPath = resolveTrashEntry(homePath, entry.trashPath);
      if (!fullPath) {
        retained.push(entry);
        continue;
      }
      try {
        await rm(fullPath, { recursive: true, force: true });
        deleted += 1;
      } catch (error: unknown) {
        console.warn("[trash] Could not remove trash entry:", safeLogError(error));
        retained.push(entry);
      }
    }
    await writeManifest(trashDir, retained);
    return { ok: true, deleted };
  });
}

function authorizeTrashSource(
  homePath: string,
  requestedPath: string,
): { ok: false; error: string; status?: number } | undefined {
  if (!FileManagementPathSchema.safeParse(requestedPath).success) {
    return { ok: false, error: "Invalid path" };
  }
  const capabilities = getFileEntryCapabilities(homePath, requestedPath);
  if (capabilities.canTrash) return undefined;
  if (capabilities.readOnlyReason === "protected") {
    return { ok: false, error: "Protected path cannot be deleted", status: 403 };
  }
  return { ok: false, error: "Invalid path" };
}

async function readManifest(trashDir: string): Promise<TrashManifestEntry[]> {
  try {
    if (!await assertTrashDirectory(trashDir, true)) return [];
    const manifestPath = join(trashDir, ".manifest.json");
    const manifestStats = await lstat(manifestPath).catch((error: unknown) => {
      if (isErrno(error, "ENOENT")) return null;
      throw error;
    });
    if (!manifestStats) return [];
    if (!manifestStats.isFile() || manifestStats.isSymbolicLink()) {
      throw new TrashManifestUnavailableError();
    }
    const data = await readFile(manifestPath, "utf8");
    return parseManifest(data);
  } catch (error: unknown) {
    if (isErrno(error, "ENOENT")) return [];
    console.error("[trash] Could not read trash manifest:", safeLogError(error));
    throw error instanceof TrashManifestUnavailableError
      ? error
      : new TrashManifestUnavailableError();
  }
}

function parseManifest(data: string): TrashManifestEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch (error: unknown) {
    if (!(error instanceof SyntaxError)) {
      console.error("[trash] Unexpected manifest parse failure:", safeLogError(error));
    }
    throw new TrashManifestUnavailableError();
  }
  if (!Array.isArray(parsed) || !parsed.every(isManifestEntry)) {
    throw new TrashManifestUnavailableError();
  }
  return parsed;
}

function isManifestEntry(value: unknown): value is TrashManifestEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  if (
    typeof entry.name !== "string"
    || typeof entry.originalPath !== "string"
    || typeof entry.deletedAt !== "string"
    || typeof entry.trashPath !== "string"
  ) {
    return false;
  }
  return entry.name === posix.basename(entry.originalPath)
    && FileManagementPathSchema.safeParse(entry.originalPath).success
    && FileManagementPathSchema.safeParse(entry.trashPath).success
    && posix.dirname(entry.trashPath) === ".trash"
    && !isReservedTrashName(posix.basename(entry.trashPath))
    && Number.isFinite(Date.parse(entry.deletedAt));
}

async function writeManifest(
  trashDir: string,
  manifest: TrashManifestEntry[],
  overrides: Partial<TrashManifestIo> = {},
): Promise<void> {
  await assertTrashDirectory(trashDir, false);
  const manifestPath = join(trashDir, ".manifest.json");
  const temporaryPath = `${manifestPath}.${randomUUID()}.tmp`;
  const manifestIo: TrashManifestIo = {
    writeTemporary: (path, contents) => writeFile(path, contents, { flag: "wx" }),
    replaceManifest: rename,
    cleanupTemporary: (path) => rm(path, { force: true }),
    ...overrides,
  };
  try {
    await manifestIo.writeTemporary(temporaryPath, JSON.stringify(manifest, null, 2));
    await manifestIo.replaceManifest(temporaryPath, manifestPath);
  } finally {
    try {
      await manifestIo.cleanupTemporary(temporaryPath);
    } catch (error: unknown) {
      console.warn("[trash] Could not clean temporary manifest:", safeLogError(error));
    }
  }
}

function trashNameCandidates(name: string): string[] {
  const extension = isReservedTrashName(name) ? "" : posix.extname(name);
  const stem = extension ? name.slice(0, -extension.length) : name;
  return Array.from({ length: MAX_TRASH_NAME_CANDIDATES }, (_, index) => {
    if (index === 0) return name;
    const suffix = index === 1 ? " copy" : ` copy ${index}`;
    return fitTrashName(stem, suffix, extension);
  });
}

function fitTrashName(stem: string, suffix: string, extension: string): string {
  let preservedExtension = extension;
  let candidateStem = stem;
  if (Buffer.byteLength(`${suffix}${preservedExtension}`, "utf8") > 255) {
    candidateStem += preservedExtension;
    preservedExtension = "";
  }
  const byteLimit = 255 - Buffer.byteLength(`${suffix}${preservedExtension}`, "utf8");
  return `${truncateUtf8(candidateStem, byteLimit)}${suffix}${preservedExtension}`;
}

function truncateUtf8(value: string, byteLimit: number): string {
  let result = "";
  let bytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > byteLimit) break;
    result += character;
    bytes += characterBytes;
  }
  return result;
}

function isReservedTrashName(name: string): boolean {
  const normalized = name.toLowerCase();
  return normalized === ".manifest.json"
    || (normalized.startsWith(".manifest.json.") && normalized.endsWith(".tmp"));
}

async function assertTrashDirectory(trashDir: string, allowMissing: boolean): Promise<boolean> {
  try {
    const stats = await lstat(trashDir);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new TrashManifestUnavailableError();
    }
    return true;
  } catch (error: unknown) {
    if (allowMissing && isErrno(error, "ENOENT")) return false;
    throw error instanceof TrashManifestUnavailableError
      ? error
      : new TrashManifestUnavailableError();
  }
}

function resolveTrashEntry(homePath: string, trashPath: string): string | null {
  if (!FileManagementPathSchema.safeParse(trashPath).success || !trashPath.startsWith(".trash/")) {
    return null;
  }
  const resolved = resolveWithinHome(homePath, trashPath);
  const trashRoot = resolve(homePath, ".trash");
  return resolved?.startsWith(`${trashRoot}/`) ? resolved : null;
}

function serialize<T>(
  queue: TrashManifestQueue | undefined,
  homePath: string,
  operation: () => Promise<T>,
): Promise<T> {
  return queue ? queue.run(homePath, operation) : operation();
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function safeLogError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
