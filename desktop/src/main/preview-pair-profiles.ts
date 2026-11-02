import { claimPreviewProfile } from "./preview-pair-profile-lease.js";
import { PreviewPairIdSchema, PreviewPairGenerationSchema, PreviewPairRoleSchema } from "@matrix-os/contracts/preview-pair";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, realpath, rename, rmdir, unlink, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod/v4";
import { PreviewPairProfileBindingSchema, type PreviewPairLaunchContext } from "@matrix-os/contracts/preview-pair-launch";

const Identity = PreviewPairProfileBindingSchema.omit({ authorityGeneration: true });
const Marker = Identity.extend({ schemaVersion: z.literal(1), kind: z.literal("matrix-preview-pair-profile"),
  ownerUid: z.number().int().nonnegative() });
const unavailable = () => new Error("Preview profile is unavailable");
const missing = (error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT";
async function layout(context: z.input<typeof Identity>, home: string) {
  const identity = Identity.strip().parse(context), canonicalHome = await realpath(home);
  const matrix = join(canonicalHome, ".matrixos"), base = join(matrix, "preview-pairs"), pair = join(base, identity.pairId), generation = join(pair, `g${identity.generation}`);
  const root = join(generation, identity.role), userData = join(root, "user-data"), sessionData = join(root, "session-data");
  return { paths: { root, userData, sessionData }, parents: [matrix, base, pair, generation],
    expected: Marker.parse({ ...identity, schemaVersion: 1, kind: "matrix-preview-pair-profile", ownerUid: process.getuid?.() }) };
}
async function safeDirectory(path: string, privateDirectory: boolean) {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.()
    || (stat.mode & (privateDirectory ? 0o077 : 0o022))) throw unavailable();
}
async function ensureDirectory(path: string, privateDirectory: boolean): Promise<boolean> {
  let created = false;
  try { await mkdir(path, { mode: 0o700 }); created = true; }
  catch (error: unknown) { if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error; }
  await safeDirectory(path, privateDirectory); return created;
}
async function readMarker(root: string) {
  const file = await open(join(root, ".preview-profile.json"), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.mode & 0o077 || stat.size > 4096) throw unavailable();
    const buffer = Buffer.alloc(4097), { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 4096) throw unavailable();
    return Marker.parse(JSON.parse(buffer.subarray(0, bytesRead).toString("utf8")));
  } finally { await file.close(); }
}
async function publishMarker(root: string, expected: z.infer<typeof Marker>) {
  const temp = join(root, `.marker-${randomUUID()}.tmp`);
  const file = await open(temp, "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify(expected));
    await file.close();
    await link(temp, join(root, ".preview-profile.json"));
  } finally {
    await file.close();
    try { await unlink(temp); } catch (error: unknown) { if (!missing(error)) throw error; }
  }
}
function sameMarker(actual: z.infer<typeof Marker>, expected: z.infer<typeof Marker>) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw unavailable();
}
/** Persistent role configuration, not a temporary app or an auth source of truth.
 * Existing unmarked directories are never adopted; no normal profile is touched. */
export async function createPreviewPairProfile(context: PreviewPairLaunchContext, home = homedir()) {
  try {
    const value = await layout(context, home);
    for (const [index, parent] of value.parents.entries()) await ensureDirectory(parent, index !== 0);
    const created = await ensureDirectory(value.paths.root, true);
    if (created) await publishMarker(value.paths.root, value.expected);
    sameMarker(await readMarker(value.paths.root), value.expected);
    await ensureDirectory(value.paths.userData, true); await ensureDirectory(value.paths.sessionData, true);
    return value.paths;
  } catch (error: unknown) { console.warn("[preview-pair] profile preparation unavailable", error instanceof Error ? error.name : "UnknownError"); throw unavailable(); }
}
/** Called only after actual Source verification and before Electron path/lock or
 * credential initialization. This read-only check cannot create/adopt state. */
export async function verifyPreviewPairProfile(context: PreviewPairLaunchContext, requestedUserData: string | undefined, home = homedir()) {
  try {
    const value = await layout(context, home);
    if (!requestedUserData || resolve(requestedUserData) !== value.paths.userData) throw unavailable();
    for (const [index, parent] of value.parents.entries()) await safeDirectory(parent, index !== 0);
    await safeDirectory(value.paths.root, true); sameMarker(await readMarker(value.paths.root), value.expected);
    await safeDirectory(value.paths.userData, true); await safeDirectory(value.paths.sessionData, true);
    return value.paths;
  } catch (error: unknown) { console.warn("[preview-pair] profile selection unavailable", error instanceof Error ? error.name : "UnknownError"); throw unavailable(); }
}

/** Explicit local-only removal; a live or unknown process owner blocks cleanup.
 * Stopped cloud pairs remain cleanable without a fresh Source descriptor. */
export async function removePreviewPairProfile(id: string, generation: number, role: "owner" | "member", home = homedir()) {
  const selected = { pairId: PreviewPairIdSchema.parse(id), generation: PreviewPairGenerationSchema.parse(generation), role: PreviewPairRoleSchema.parse(role) };
  const canonical = await realpath(home), matrix = join(canonical, ".matrixos"), base = join(matrix, "preview-pairs");
  const pair = join(base, selected.pairId), gen = join(pair, `g${selected.generation}`), root = join(gen, selected.role);
  // react-doctor-disable-next-line react-doctor/async-await-in-loop -- each owned parent must be checked before traversing its child.
  for (const [index, path] of [matrix, base, pair, gen, root].entries()) await safeDirectory(path, index !== 0);
  const marker = await readMarker(root), value = await layout(marker, home);
  if (value.paths.root !== root) throw unavailable();
  sameMarker(marker, value.expected);
  const lease = await claimPreviewProfile(root);
  const quarantine = join(gen, `.${selected.role}-cleanup`), retired = join(quarantine, "profile");
  let created = false;
  try {
    // Keep the locked profile intact until one atomic rename removes its public
    // path. A concurrent fresh launch then owns a different directory/inode.
    // One fixed quarantine per role bounds crash leftovers and fails closed.
    await mkdir(quarantine, { mode: 0o700 }); created = true;
    await safeDirectory(quarantine, true);
    await rename(root, retired);
    await rm(retired, { recursive: true, force: false });
  } finally {
    await lease.release();
    if (created) await rmdir(quarantine); // Never recursively remove unknown leftovers.
  }
}
