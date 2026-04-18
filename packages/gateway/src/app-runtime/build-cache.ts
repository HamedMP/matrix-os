import { readFile, writeFile, glob, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, relative } from "node:path";

export interface BuildStamp {
  sourceHash: string;
  lockfileHash: string;
  builtAt: number;
  exitCode: number;
}

const STAMP_FILE = ".build-stamp";

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
