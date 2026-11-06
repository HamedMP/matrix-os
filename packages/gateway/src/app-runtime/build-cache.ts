import {
  glob,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join, relative } from "node:path";

export interface BuildStamp {
  sourceHash: string;
  lockfileHash: string;
  builtAt: number;
  exitCode: number;
}

const STAMP_FILE = ".build-stamp";
const COLLABORATIVE_BUILD_ID = /^[a-f0-9]{64}$/;
const MAX_SNAPSHOT_FILES = 10_000;
const MAX_SNAPSHOT_BYTES = 256 * 1024 * 1024;
const MAX_ORPHAN_SWEEP_ENTRIES = 1_000;

export interface CollaborativeBuildSnapshot {
  buildId: string;
  assetDigest: string;
  artifactPath: string;
  createdAt: number;
}

interface SnapshotMetadata {
  buildId: string;
  assetDigest: string;
  createdAt: number;
  lastReleasedAt: number;
  references: string[];
}

export class CollaborativeBuildSnapshotError extends Error {
  constructor(readonly code: "invalid_snapshot" | "build_id_collision" | "capacity") {
    super("Collaborative build snapshot is unavailable");
    this.name = "CollaborativeBuildSnapshotError";
  }
}

function parseMetadata(input: unknown): SnapshotMetadata | null {
  if (!input || typeof input !== "object") return null;
  const value = input as Partial<SnapshotMetadata>;
  if (typeof value.buildId !== "string" || !COLLABORATIVE_BUILD_ID.test(value.buildId)
    || typeof value.assetDigest !== "string" || !COLLABORATIVE_BUILD_ID.test(value.assetDigest)
    || typeof value.createdAt !== "number" || !Number.isFinite(value.createdAt)
    || typeof value.lastReleasedAt !== "number" || !Number.isFinite(value.lastReleasedAt)
    || !Array.isArray(value.references) || value.references.length > 1_000
    || value.references.some((reference) => typeof reference !== "string" || reference.length < 1 || reference.length > 256)) {
    return null;
  }
  return { ...value, references: [...new Set(value.references)] } as SnapshotMetadata;
}

function publicSnapshot(metadata: SnapshotMetadata, artifactPath: string): CollaborativeBuildSnapshot {
  return {
    buildId: metadata.buildId,
    assetDigest: metadata.assetDigest,
    artifactPath,
    createdAt: metadata.createdAt,
  };
}

export class ImmutableCollaborativeBuildStore {
  private readonly objectsDir: string;
  private readonly metadataDir: string;
  private readonly timer: NodeJS.Timeout | undefined;
  private closed = false;
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(private readonly options: {
    rootDir: string;
    maxSnapshots: number;
    retentionMs: number;
    cleanupIntervalMs: number;
    startTimer?: boolean;
    now?: () => number;
  }) {
    if (!Number.isInteger(options.maxSnapshots) || options.maxSnapshots < 1
      || !Number.isFinite(options.retentionMs) || options.retentionMs < 0
      || !Number.isFinite(options.cleanupIntervalMs) || options.cleanupIntervalMs < 1) {
      throw new CollaborativeBuildSnapshotError("invalid_snapshot");
    }
    this.objectsDir = join(options.rootDir, "objects");
    this.metadataDir = join(options.rootDir, "metadata");
    this.timer = options.startTimer === false ? undefined : setInterval(() => {
      void this.cleanup().catch((error: unknown) => {
        console.warn("[collaborative-build-store] cleanup failed", error instanceof Error ? error.name : "UnknownError");
      });
    }, options.cleanupIntervalMs);
    this.timer?.unref();
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private async initialize(): Promise<void> {
    await Promise.all([
      mkdir(this.objectsDir, { recursive: true }),
      mkdir(this.metadataDir, { recursive: true }),
    ]);
  }

  private async withMutationLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.mutationTail;
    let release!: () => void;
    this.mutationTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private artifactPath(buildId: string): string {
    return join(this.objectsDir, buildId);
  }

  private metadataPath(buildId: string): string {
    return join(this.metadataDir, `${buildId}.json`);
  }

  private async readMetadata(buildId: string): Promise<SnapshotMetadata | null> {
    try {
      const file = this.metadataPath(buildId);
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink()) return null;
      return parseMetadata(JSON.parse(await readFile(file, "utf8")));
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  private async writeMetadata(metadata: SnapshotMetadata): Promise<void> {
    const temporary = join(this.metadataDir, `.${metadata.buildId}.${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(metadata), { flag: "wx", mode: 0o600 });
    try {
      await rename(temporary, this.metadataPath(metadata.buildId));
    } finally {
      await rm(temporary, { force: true });
    }
  }

  private async copyAndDigest(source: string, destination: string): Promise<string> {
    const root = await lstat(source);
    if (!root.isDirectory() || root.isSymbolicLink()) throw new CollaborativeBuildSnapshotError("invalid_snapshot");
    const hash = createHash("sha256");
    let fileCount = 0;
    let byteCount = 0;

    const visit = async (sourceDir: string, destinationDir: string, prefix: string): Promise<void> => {
      await mkdir(destinationDir, { recursive: true, mode: 0o700 });
      const entries = (await readdir(sourceDir, { withFileTypes: true }))
        .sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        const sourcePath = join(sourceDir, entry.name);
        const destinationPath = join(destinationDir, entry.name);
        const path = prefix ? `${prefix}/${entry.name}` : entry.name;
        const info = await lstat(sourcePath);
        if (info.isSymbolicLink()) throw new CollaborativeBuildSnapshotError("invalid_snapshot");
        if (info.isDirectory()) {
          hash.update(`d\0${path}\0`);
          await visit(sourcePath, destinationPath, path);
          continue;
        }
        if (!info.isFile()) throw new CollaborativeBuildSnapshotError("invalid_snapshot");
        fileCount += 1;
        byteCount += info.size;
        if (fileCount > MAX_SNAPSHOT_FILES || byteCount > MAX_SNAPSHOT_BYTES) {
          throw new CollaborativeBuildSnapshotError("capacity");
        }
        const bytes = await readFile(sourcePath);
        hash.update(`f\0${path}\0${bytes.length}\0`);
        hash.update(bytes);
        await writeFile(destinationPath, bytes, { flag: "wx", mode: 0o600 });
      }
    };

    await visit(source, destination, "");
    return hash.digest("hex");
  }

  async capture(input: { buildRoot: string; buildId: string }): Promise<CollaborativeBuildSnapshot> {
    if (!COLLABORATIVE_BUILD_ID.test(input.buildId)) {
      throw new CollaborativeBuildSnapshotError("invalid_snapshot");
    }
    return this.captureIdentified({
      buildRoot: input.buildRoot,
      buildIdForAssetDigest: () => input.buildId,
    });
  }

  async captureIdentified(input: {
    buildRoot: string;
    buildIdForAssetDigest: (assetDigest: string) => string;
  }): Promise<CollaborativeBuildSnapshot> {
    if (this.closed) {
      throw new CollaborativeBuildSnapshotError("invalid_snapshot");
    }
    await this.initialize();
    const temporary = join(this.objectsDir, `.capture-${randomUUID()}`);
    await mkdir(temporary, { mode: 0o700 });
    try {
      const assetDigest = await this.copyAndDigest(input.buildRoot, temporary);
      const buildId = input.buildIdForAssetDigest(assetDigest);
      if (!COLLABORATIVE_BUILD_ID.test(buildId)) {
        throw new CollaborativeBuildSnapshotError("invalid_snapshot");
      }
      return await this.withMutationLock(async () => {
        const existing = await this.readMetadata(buildId);
        if (existing) {
          if (existing.assetDigest !== assetDigest) throw new CollaborativeBuildSnapshotError("build_id_collision");
          return publicSnapshot(existing, this.artifactPath(buildId));
        }
        const artifactPath = this.artifactPath(buildId);
        try {
          const orphan = await lstat(artifactPath);
          if (!orphan.isDirectory() || orphan.isSymbolicLink()) {
            throw new CollaborativeBuildSnapshotError("invalid_snapshot");
          }
          await rm(artifactPath, { recursive: true, force: true });
        } catch (error: unknown) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        await rename(temporary, artifactPath);
        const createdAt = this.now();
        const metadata: SnapshotMetadata = {
          buildId,
          assetDigest,
          createdAt,
          lastReleasedAt: createdAt,
          references: [],
        };
        try {
          await this.writeMetadata(metadata);
        } catch (error: unknown) {
          await rm(artifactPath, { recursive: true, force: true });
          throw error;
        }
        return { buildId, assetDigest, artifactPath, createdAt };
      });
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }

  async resolve(buildId: string): Promise<CollaborativeBuildSnapshot | null> {
    if (!COLLABORATIVE_BUILD_ID.test(buildId)) return null;
    const metadata = await this.readMetadata(buildId);
    if (!metadata) return null;
    try {
      const info = await lstat(this.artifactPath(buildId));
      if (!info.isDirectory() || info.isSymbolicLink()) return null;
      return publicSnapshot(metadata, this.artifactPath(buildId));
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async retain(buildId: string, reference: string): Promise<void> {
    if (reference.length < 1 || reference.length > 256) throw new CollaborativeBuildSnapshotError("invalid_snapshot");
    await this.withMutationLock(async () => {
      const metadata = await this.readMetadata(buildId);
      if (!metadata) throw new CollaborativeBuildSnapshotError("invalid_snapshot");
      if (!metadata.references.includes(reference)) metadata.references.push(reference);
      if (metadata.references.length > 1_000) throw new CollaborativeBuildSnapshotError("capacity");
      await this.writeMetadata(metadata);
    });
  }

  async release(buildId: string, reference: string): Promise<void> {
    await this.withMutationLock(async () => {
      const metadata = await this.readMetadata(buildId);
      if (!metadata) return;
      metadata.references = metadata.references.filter((candidate) => candidate !== reference);
      if (metadata.references.length === 0) metadata.lastReleasedAt = this.now();
      await this.writeMetadata(metadata);
    });
  }

  async cleanup(): Promise<{ removed: number }> {
    await this.initialize();
    return this.withMutationLock(async () => {
      const metadata: SnapshotMetadata[] = [];
      for (const entry of await readdir(this.metadataDir, { withFileTypes: true })) {
        if (!entry.isFile() || entry.isSymbolicLink() || !/^[a-f0-9]{64}\.json$/.test(entry.name)) continue;
        const item = await this.readMetadata(entry.name.slice(0, 64));
        if (item) metadata.push(item);
      }
      metadata.sort((left, right) => left.createdAt - right.createdAt || left.buildId.localeCompare(right.buildId));
      let excess = Math.max(0, metadata.length - this.options.maxSnapshots);
      let removed = 0;
      for (const item of metadata) {
        if (item.references.length > 0) continue;
        const expired = this.now() - item.lastReleasedAt >= this.options.retentionMs;
        if (!expired && excess <= 0) continue;
        let artifact;
        try {
          artifact = await lstat(this.artifactPath(item.buildId));
        } catch (error: unknown) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        if (artifact?.isSymbolicLink()) continue;
        if (artifact) await rm(this.artifactPath(item.buildId), { recursive: true, force: true });
        await rm(this.metadataPath(item.buildId), { force: true });
        removed += 1;
        excess = Math.max(0, excess - 1);
      }
      const objectEntries = (await readdir(this.objectsDir, { withFileTypes: true }))
        .slice(0, MAX_ORPHAN_SWEEP_ENTRIES);
      for (const entry of objectEntries) {
        if (!entry.isDirectory() || entry.isSymbolicLink() || !COLLABORATIVE_BUILD_ID.test(entry.name)) continue;
        if (await this.readMetadata(entry.name)) continue;
        await rm(this.artifactPath(entry.name), { recursive: true, force: true });
        removed += 1;
      }
      return { removed };
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    await this.mutationTail;
  }
}

export async function hashSources(appDir: string, globs: string[]): Promise<string> {
  const files: string[] = [];
  for (const pattern of globs) {
    for await (const match of glob(pattern, { cwd: appDir })) {
      const abs = join(appDir, match);
      try {
        const st = await stat(abs);
        if (st.isFile()) files.push(abs);
      } catch (err: unknown) {
        // ENOENT is expected for symlink-to-missing; rethrow anything else
        // (EACCES, EIO, EMFILE) so the build surfaces real filesystem errors
        // rather than silently dropping files from the source hash.
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
    }
  }

  // Sort by relative path for determinism regardless of filesystem order
  files.sort((a, b) => relative(appDir, a).localeCompare(relative(appDir, b)));

  const hash = createHash("sha256");
  for (const file of files) {
    const relPath = relative(appDir, file);
    hash.update(relPath);
    const content = await readFile(file);
    hash.update(content);
  }
  return hash.digest("hex");
}

export async function hashLockfile(appDir: string): Promise<string> {
  try {
    const content = await readFile(join(appDir, "pnpm-lock.yaml"));
    return createHash("sha256").update(content).digest("hex");
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return "";
    }
    throw err;
  }
}

export async function readBuildStamp(appDir: string): Promise<BuildStamp | null> {
  try {
    const raw = await readFile(join(appDir, STAMP_FILE), "utf8");
    const parsed = JSON.parse(raw) as BuildStamp;
    if (
      typeof parsed.sourceHash !== "string" ||
      typeof parsed.lockfileHash !== "string" ||
      typeof parsed.builtAt !== "number" ||
      typeof parsed.exitCode !== "number"
    ) {
      return null;
    }
    return parsed;
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

export async function writeBuildStamp(appDir: string, stamp: BuildStamp): Promise<void> {
  await writeFile(join(appDir, STAMP_FILE), JSON.stringify(stamp, null, 2));
}

export async function isBuildStale(appDir: string, sourceGlobs: string[]): Promise<boolean> {
  const stamp = await readBuildStamp(appDir);
  if (!stamp) return true;

  // Failed builds are always stale
  if (stamp.exitCode !== 0) return true;

  const currentSourceHash = await hashSources(appDir, sourceGlobs);
  if (currentSourceHash !== stamp.sourceHash) return true;

  const currentLockfileHash = await hashLockfile(appDir);
  if (currentLockfileHash !== stamp.lockfileHash) return true;

  return false;
}
