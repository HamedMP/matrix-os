import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod/v4";

export const MIRROR_STATE_DIR = ".matrix-home-mirror";
const MAX_ENTRIES = 50_000;
const MAX_STATE_BYTES = 8 * 1024 * 1024;
const MAX_CONFLICTS = 100;
const MAX_CONFLICT_BYTES = 100 * 1024 * 1024;
const Hash = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const Path = z.string().min(1).max(1024).refine((path) =>
  !path.startsWith("/") && !path.includes("\\") && !/[\x00-\x1f\x7f]/.test(path)
  && path.split("/").every((part) => part !== ".." && part !== "." && part !== "")
  && !path.startsWith(`${MIRROR_STATE_DIR}/`));
const State = z.object({
  version: z.literal(1),
  hashes: z.record(Path, Hash).refine((value) => Object.keys(value).length <= MAX_ENTRIES),
  conflicts: z.record(Path, z.object({
    localHash: Hash, remoteHash: Hash,
    artifact: z.string().regex(/^conflict-[a-f0-9]{64}\.bin$/),
  })).refine((value) => Object.keys(value).length <= MAX_CONFLICTS),
});
type StateData = z.infer<typeof State>;
function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/** Host-local sync baseline, never advertised, uploaded or treated as owner content. */
export class HomeMirrorState {
  private state: StateData = { version: 1, hashes: Object.create(null), conflicts: Object.create(null) };
  private readonly dir: string;
  private rootPath: string | undefined;
  private directoryIdentity: string | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private writes: Promise<void> = Promise.resolve();
  constructor(private readonly homeRoot: string, private readonly warn: (category: string) => void) {
    this.dir = join(homeRoot, MIRROR_STATE_DIR);
  }
  private async checkDirectory(): Promise<void> {
    const resolvedRoot = await realpath(this.homeRoot);
    if (this.rootPath && resolvedRoot !== this.rootPath) throw new Error("unsafe mirror state parent");
    this.rootPath ??= resolvedRoot;
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const info = await lstat(this.dir);
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(this.dir) !== join(this.rootPath, MIRROR_STATE_DIR)) {
      throw new Error("unsafe mirror state directory");
    }
    const identity = `${info.dev}:${info.ino}`;
    if (this.directoryIdentity && identity !== this.directoryIdentity) throw new Error("unsafe replaced mirror state directory");
    this.directoryIdentity ??= identity;
  }
  async load(): Promise<void> {
    await this.checkDirectory();
    try {
      const file = await open(join(this.dir, "state.json"), constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const info = await file.stat();
        if (!info.isFile() || info.size > MAX_STATE_BYTES) throw new SyntaxError("invalid mirror state size");
        const bytes = Buffer.alloc(Math.min(info.size + 1, MAX_STATE_BYTES + 1));
        const read = await file.read(bytes, 0, bytes.length, 0);
        if (read.bytesRead > MAX_STATE_BYTES) throw new SyntaxError("invalid mirror state size");
        const parsed: unknown = JSON.parse(bytes.subarray(0, read.bytesRead).toString("utf8"));
        const result = State.safeParse(parsed);
        if (!result.success) throw new SyntaxError("invalid mirror state schema");
        this.state = { ...result.data, hashes: Object.assign(Object.create(null), result.data.hashes), conflicts: Object.assign(Object.create(null), result.data.conflicts) };
      } finally { await file.close(); }
    } catch (error: unknown) {
      if (!missing(error) && !(error instanceof SyntaxError)) throw error;
      // Unknown baselines are never permission to replace an existing local file.
      this.state = { version: 1, hashes: Object.create(null), conflicts: Object.create(null) };
      if (!missing(error)) this.warn("invalid_baseline");
    }
    await this.cleanupTemps();
    this.timer ??= setInterval(() => {
      void this.cleanupTemps().catch((error: unknown) => this.warn(error instanceof Error ? "temp_cleanup_failed" : "temp_cleanup_non_error"));
    }, 5 * 60_000);
    this.timer.unref();
  }
  paths(): string[] { return Object.keys(this.state.hashes); }
  hash(path: string): string | undefined { return Object.hasOwn(this.state.hashes, path) ? this.state.hashes[path] : undefined; }
  blocked(path: string): boolean { return Object.hasOwn(this.state.conflicts, path); }
  async remember(path: string, hash: string): Promise<void> {
    Path.parse(path); Hash.parse(hash);
    if (!Object.hasOwn(this.state.hashes, path) && Object.keys(this.state.hashes).length >= MAX_ENTRIES) {
      throw new Error("mirror baseline capacity exhausted");
    }
    this.state.hashes[path] = hash;
    delete this.state.conflicts[path];
    await this.save();
  }
  async forget(path: string): Promise<void> {
    Path.parse(path);
    delete this.state.hashes[path]; delete this.state.conflicts[path]; await this.save();
  }
  async preserve(path: string, localHash: string, remoteHash: string, bytes: Buffer): Promise<void> {
    Path.parse(path); Hash.parse(localHash); Hash.parse(remoteHash);
    if (`sha256:${createHash("sha256").update(bytes).digest("hex")}` !== remoteHash) {
      throw new Error("invalid conflict content");
    }
    await this.checkDirectory();
    const artifact = `conflict-${createHash("sha256").update(path).update(remoteHash).digest("hex")}.bin`;
    let count = 0; let size = 0;
    const names = await readdir(this.dir);
    if (names.length > 1_000) throw new Error("mirror state directory capacity exhausted");
    for (const name of names) {
      if (!/^conflict-[a-f0-9]{64}\.bin$/.test(name)) continue;
      const info = await lstat(join(this.dir, name));
      if (!info.isFile() || info.isSymbolicLink()) throw new Error("unsafe conflict artifact");
      count++; size += info.size;
    }
    try {
      const existing = await open(join(this.dir, artifact), constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const info = await existing.stat();
        if (!info.isFile() || info.size > MAX_CONFLICT_BYTES) throw new Error("invalid conflict artifact");
        const hash = createHash("sha256").update(await existing.readFile()).digest("hex");
        if (`sha256:${hash}` !== remoteHash) throw new Error("conflict artifact mismatch");
      } finally { await existing.close(); }
    } catch (error: unknown) {
      if (!missing(error)) throw error;
      if (count >= MAX_CONFLICTS || size + bytes.length > MAX_CONFLICT_BYTES) throw new Error("conflict capacity exhausted");
      await writeFile(join(this.dir, artifact), bytes, { flag: "wx", mode: 0o600 });
    }
    if (!Object.hasOwn(this.state.conflicts, path) && Object.keys(this.state.conflicts).length >= MAX_CONFLICTS) {
      throw new Error("conflict capacity exhausted");
    }
    this.state.conflicts[path] = { localHash, remoteHash, artifact };
    await this.save();
    this.warn("conflict_preserved");
  }
  private save(): Promise<void> {
    const next = this.writes.then(() => this.saveNow());
    this.writes = next.catch((error: unknown) => { this.warn(error instanceof Error ? "state_write_failed" : "state_write_non_error"); });
    return next;
  }
  private async saveNow(): Promise<void> {
    await this.checkDirectory();
    const target = join(this.dir, "state.json");
    try { if ((await lstat(target)).isSymbolicLink()) throw new Error("unsafe mirror state file"); }
    catch (error: unknown) { if (!missing(error)) throw error; }
    const contents = JSON.stringify(this.state);
    if (Buffer.byteLength(contents) > MAX_STATE_BYTES) throw new Error("mirror state capacity exhausted");
    const temp = join(this.dir, `state-${randomUUID()}.tmp`);
    try {
      await writeFile(temp, contents, { flag: "wx", mode: 0o600 });
      await this.checkDirectory();
      await rename(temp, target);
    } finally {
      await unlink(temp).catch((error: unknown) => { if (!missing(error)) this.warn("temp_cleanup_failed"); });
    }
  }
  private async cleanupTemps(): Promise<void> {
    await this.checkDirectory();
    const names = await readdir(this.dir);
    if (names.length > 1_000) throw new Error("mirror state directory capacity exhausted");
    for (const name of names) {
      if (!/^state-[0-9a-f-]{36}\.tmp$/.test(name)) continue;
      const file = join(this.dir, name); const info = await lstat(file);
      if (info.isFile() && !info.isSymbolicLink() && Date.now() - info.mtimeMs > 60 * 60_000) await unlink(file);
    }
  }
  close(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }
}
