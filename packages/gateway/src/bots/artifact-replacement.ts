/** Hash-checked capture and exclusive publication; never a POSIX rename CAS. */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, link, lstat, mkdir, open, rename, rmdir, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { BOT_ARTIFACT_MAX_BYTES } from "@matrix-os/contracts";
import { BotBrokerActionError } from "./broker-actions.js";

export const ARTIFACT_RECOVERY_DIRECTORY = ".artifact-recovery";
const active = new Set<string>(); // At most 64; removed in finally, no waiting queue.
const isCode = (error: unknown, code: string) => error instanceof Error && "code" in error && error.code === code;

/** Generic effect uncertainty; the broker must never classify this as a refusal/replay. */
export class ArtifactRecoveryRequired extends Error {
  constructor(readonly recoveryId: string) {
    super(`Artifact outcome unconfirmed; owner recovery ${recoveryId}`);
    this.name = "ArtifactRecoveryRequired";
  }
}

async function snapshot(path: string) {
  let file;
  try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error: unknown) {
    if (["ELOOP", "ENOENT", "EISDIR"].some(code => isCode(error, code))) throw new BotBrokerActionError("invalid_arguments");
    throw error;
  }
  try {
    const before = await file.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > BOT_ARTIFACT_MAX_BYTES) throw new BotBrokerActionError("invalid_arguments");
    const bytes = Buffer.alloc(BOT_ARTIFACT_MAX_BYTES + 1);
    let size = 0;
    for (;;) {
      const result = await file.read(bytes, size, bytes.length - size, size);
      size += result.bytesRead;
      if (size > BOT_ARTIFACT_MAX_BYTES) throw new BotBrokerActionError("invalid_arguments");
      if (!result.bytesRead) break;
    }
    const after = await file.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new BotBrokerActionError("artifact_digest_mismatch");
    return { ino: before.ino, dev: before.dev, mode: before.mode & 0o777,
      sha256: createHash("sha256").update(bytes.subarray(0, size)).digest("hex") };
  } finally { await file.close(); }
}

async function syncDirectory(path: string) {
  const directory = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await directory.sync(); } finally { await directory.close(); }
}

async function reserve(homePath: string) {
  const home = await lstat(homePath);
  if (!home.isDirectory() || home.isSymbolicLink()) throw new BotBrokerActionError("unavailable");
  const root = join(homePath, ARTIFACT_RECOVERY_DIRECTORY);
  try { await mkdir(root, { mode: 0o700 }); }
  catch (error: unknown) { if (!isCode(error, "EEXIST")) throw error; }
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0
    || (typeof process.getuid === "function" && info.uid !== process.getuid())) throw new BotBrokerActionError("unavailable");
  for (let index = 0; index < 64; index++) {
    const id = `slot-${String(index).padStart(2, "0")}`;
    const path = join(root, id);
    try { await mkdir(path, { mode: 0o700 }); return { id, path }; }
    catch (error: unknown) { if (!isCode(error, "EEXIST")) throw error; }
  }
  throw new BotBrokerActionError("unavailable");
}

export async function replaceBotArtifact(options: {
  homePath: string; target: string; staged: string; relPath: string; expectedSha256: string;
  revalidate(): Promise<void>;
}): Promise<string> {
  const { target, staged, expectedSha256 } = options;
  if (active.has(target) || active.size >= 64) throw new BotBrokerActionError("unavailable");
  active.add(target);
  let slot: Awaited<ReturnType<typeof reserve>> | undefined;
  let captureAttempted = false;
  let published = false;
  try {
    const before = await snapshot(target);
    if (before.sha256 !== expectedSha256) throw new BotBrokerActionError("artifact_digest_mismatch");
    await chmod(staged, before.mode);
    slot = await reserve(options.homePath);
    // Owner-only recovery metadata; no TTL, automatic deletion or model access.
    const record = await open(join(slot.path, "record.json"), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      await record.writeFile(JSON.stringify({ version: 1, target, relPath: options.relPath, expectedSha256, createdAt: new Date().toISOString() }));
      await record.sync();
    } finally { await record.close(); }
    await syncDirectory(slot.path);
    await syncDirectory(dirname(slot.path));
    await syncDirectory(options.homePath);
    if ((await lstat(slot.path)).dev !== before.dev || (await lstat(staged)).dev !== before.dev) throw new BotBrokerActionError("invalid_arguments");
    await options.revalidate();
    captureAttempted = true;
    await rename(target, join(slot.path, "previous"));
    const captured = await snapshot(join(slot.path, "previous"));
    if (captured.ino !== before.ino || captured.dev !== before.dev || captured.mode !== before.mode || captured.sha256 !== expectedSha256) throw new ArtifactRecoveryRequired(slot.id);
    await syncDirectory(slot.path);
    await syncDirectory(dirname(target));
    await options.revalidate();
    // Brief absent-target window is deliberate: any concurrent owner-created
    // path wins. No overwrite rename can discard that edit.
    await link(staged, target);
    published = true;
    await syncDirectory(dirname(target));
    // Retain the old inode even after success: an already-open Terminal fd may
    // write it later. Only the owner reviews and removes recovery slots.
    return slot.id;
  } catch (error: unknown) {
    if (captureAttempted && slot) {
      if (!published) {
        try { await link(join(slot.path, "previous"), target); }
        catch (restore: unknown) {
          if (!isCode(restore, "EEXIST") && !isCode(restore, "ENOENT")) console.warn("[bots] artifact recovery restore unavailable", slot.id);
        }
      }
      throw new ArtifactRecoveryRequired(slot.id);
    }
    if (slot) {
      try { await unlink(join(slot.path, "record.json")); }
      catch (cleanup: unknown) { if (!isCode(cleanup, "ENOENT")) console.warn("[bots] recovery metadata cleanup failed", slot.id); }
      try { await rmdir(slot.path); }
      catch (cleanup: unknown) { if (!isCode(cleanup, "ENOENT")) console.warn("[bots] empty recovery slot cleanup failed", slot.id); }
    }
    throw error;
  } finally { active.delete(target); }
}
