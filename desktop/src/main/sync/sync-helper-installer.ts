import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  rename,
  unlink,
} from "node:fs/promises";
import { createReadStream } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { z } from "zod/v4";

const MAX_HELPER_MANIFEST_BYTES = 16 * 1024;
const HelperVersionSchema = z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const PlatformSchema = z.enum(["darwin", "linux"]);
const ArchSchema = z.enum(["x64", "arm64"]);

const PackagedHelperManifestSchema = z.discriminatedUnion("available", [
  z.object({
    schemaVersion: z.literal(1),
    available: z.literal(true),
    protocolVersion: z.literal(1),
    cliVersion: HelperVersionSchema,
    platform: PlatformSchema,
    arch: ArchSchema,
    executable: z.literal("matrix"),
    sha256: HashSchema,
  }).strict(),
  z.object({
    schemaVersion: z.literal(1),
    available: z.literal(false),
    protocolVersion: z.literal(1),
    platform: z.string().min(1).max(32),
    arch: z.string().min(1).max(32),
    reason: z.literal("platform_unsupported"),
  }).strict(),
]);

const InstalledHelperSchema = z.object({
  schemaVersion: z.literal(1),
  protocolVersion: z.literal(1),
  cliVersion: HelperVersionSchema,
  platform: PlatformSchema,
  arch: ArchSchema,
  executable: z.string().min(1).max(4096).refine(isAbsolute),
  sha256: HashSchema,
}).strict();

export type InstalledSyncHelperRecord = z.infer<typeof InstalledHelperSchema>;

export interface InstalledSyncHelper extends InstalledSyncHelperRecord {
  source: "packaged" | "current";
  previous?: InstalledSyncHelperRecord;
}

function codedError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

async function readBoundedJson(path: string): Promise<unknown> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_HELPER_MANIFEST_BYTES) {
    throw codedError("sync_helper_manifest_invalid");
  }
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw codedError("sync_helper_manifest_invalid");
  }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  const stream = createReadStream(path);
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function inside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

async function assertRegularExecutable(path: string, expectedHash: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o111) === 0) {
    throw codedError("sync_helper_executable_invalid");
  }
  if (await sha256File(path) !== expectedHash) {
    throw codedError("sync_helper_digest_mismatch");
  }
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  try {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw codedError("sync_helper_directory_unsafe");
    if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
      throw codedError("sync_helper_directory_unsafe");
    }
    return;
  } catch (err: unknown) {
    if (!(err instanceof Error) || !("code" in err) || err.code !== "ENOENT") throw err;
  }
  await mkdir(path, { mode: 0o700 });
}

function compareVersions(left: string, right: string): number {
  const parse = (value: string) => {
    const [core, prerelease] = value.split("-", 2);
    return { parts: core!.split(".").map(Number), prerelease };
  };
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index++) {
    const difference = a.parts[index]! - b.parts[index]!;
    if (difference !== 0) return Math.sign(difference);
  }
  if (a.prerelease === b.prerelease) return 0;
  if (a.prerelease === undefined) return 1;
  if (b.prerelease === undefined) return -1;
  return a.prerelease.localeCompare(b.prerelease);
}

export async function verifySyncHelper(
  helper: Omit<InstalledSyncHelper, "source"> | InstalledSyncHelper,
): Promise<void> {
  const { source: _source, previous: _previous, ...candidate } = helper as InstalledSyncHelper;
  const parsed = InstalledHelperSchema.parse(candidate);
  await assertRegularExecutable(parsed.executable, parsed.sha256);
}

async function loadCurrentHelper(
  helpersRoot: string,
  platform: "darwin" | "linux",
  arch: "x64" | "arm64",
): Promise<z.infer<typeof InstalledHelperSchema> | null> {
  try {
    const current = InstalledHelperSchema.parse(
      await readBoundedJson(join(helpersRoot, "current.json")),
    );
    if (
      current.platform !== platform
      || current.arch !== arch
      || !inside(helpersRoot, current.executable)
    ) {
      throw codedError("sync_helper_current_invalid");
    }
    await verifySyncHelper(current);
    return current;
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") return null;
    throw err;
  }
}

async function writeCurrentMarker(
  helpersRoot: string,
  helper: z.infer<typeof InstalledHelperSchema>,
): Promise<void> {
  const destination = join(helpersRoot, "current.json");
  const temporary = join(helpersRoot, `.current-${randomUUID()}.tmp`);
  try {
    await import("node:fs/promises").then(({ writeFile }) => writeFile(
      temporary,
      `${JSON.stringify(helper, null, 2)}\n`,
      { flag: "wx", mode: 0o600 },
    ));
    await rename(temporary, destination);
  } catch (err: unknown) {
    await unlink(temporary).catch(() => undefined);
    throw err;
  }
}

export async function installPackagedSyncHelper(options: {
  resourcesPath: string;
  homeDir: string;
  platform: NodeJS.Platform;
  arch: string;
}): Promise<InstalledSyncHelper> {
  if (!PlatformSchema.safeParse(options.platform).success || !ArchSchema.safeParse(options.arch).success) {
    throw codedError("sync_helper_platform_unsupported");
  }
  const platform = PlatformSchema.parse(options.platform);
  const arch = ArchSchema.parse(options.arch);
  const packagedRoot = join(options.resourcesPath, "sync-helper");
  const manifest = PackagedHelperManifestSchema.parse(
    await readBoundedJson(join(packagedRoot, "manifest.json")),
  );
  if (!manifest.available) throw codedError("sync_helper_platform_unsupported");
  if (manifest.platform !== platform || manifest.arch !== arch) {
    throw codedError("sync_helper_target_mismatch");
  }
  const packagedExecutable = join(packagedRoot, manifest.executable);
  await assertRegularExecutable(packagedExecutable, manifest.sha256);

  const matrixRoot = join(options.homeDir, ".matrixos");
  try {
    await ensurePrivateDirectory(matrixRoot);
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") {
      await mkdir(dirname(matrixRoot), { recursive: true });
      await ensurePrivateDirectory(matrixRoot);
    } else {
      throw err;
    }
  }
  const helpersRoot = join(matrixRoot, "helpers");
  await ensurePrivateDirectory(helpersRoot);
  const current = await loadCurrentHelper(helpersRoot, platform, arch);
  if (current && compareVersions(current.cliVersion, manifest.cliVersion) >= 0) {
    return { ...current, source: "current" };
  }

  const versionRoot = join(helpersRoot, manifest.cliVersion);
  await ensurePrivateDirectory(versionRoot);
  const installedExecutable = join(versionRoot, "matrix");
  try {
    await copyFile(packagedExecutable, installedExecutable, constants.COPYFILE_EXCL);
    await chmod(installedExecutable, 0o700);
  } catch (err: unknown) {
    if (!(err instanceof Error) || !("code" in err) || err.code !== "EEXIST") throw err;
  }
  await assertRegularExecutable(installedExecutable, manifest.sha256);
  const installed = InstalledHelperSchema.parse({
    schemaVersion: 1,
    protocolVersion: manifest.protocolVersion,
    cliVersion: manifest.cliVersion,
    platform,
    arch,
    executable: installedExecutable,
    sha256: manifest.sha256,
  });
  await writeCurrentMarker(helpersRoot, installed);
  return { ...installed, source: "packaged", ...(current ? { previous: current } : {}) };
}

export async function restoreSyncHelperSelection(
  homeDir: string,
  previous: InstalledSyncHelperRecord,
): Promise<void> {
  const helpersRoot = join(homeDir, ".matrixos", "helpers");
  if (!inside(helpersRoot, previous.executable)) {
    throw codedError("sync_helper_current_invalid");
  }
  await verifySyncHelper(previous);
  await writeCurrentMarker(helpersRoot, InstalledHelperSchema.parse(previous));
}
