import { lstat, readFile, readdir, stat, writeFile } from "node:fs/promises";
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
  const files = new Set<string>();
  for (const pattern of globs) {
    const candidates = await listFilesForPattern(appDir, pattern);
    for (const match of candidates) {
      if (!matchesGlob(match, pattern)) continue;
      const abs = join(appDir, match);
      try {
        const st = await lstat(abs);
        if (st.isFile()) {
          files.add(abs);
        } else if (st.isSymbolicLink()) {
          const target = await stat(abs);
          if (target.isFile()) files.add(abs);
        }
      } catch (err: unknown) {
        // ENOENT is expected for symlink-to-missing; rethrow anything else
        // (EACCES, EIO, EMFILE) so the build surfaces real filesystem errors
        // rather than silently dropping files from the source hash.
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
    }
  }

  // Sort by relative path for determinism regardless of filesystem order
  const sortedFiles = [...files].sort((a, b) => relative(appDir, a).localeCompare(relative(appDir, b)));

  const hash = createHash("sha256");
  for (const file of sortedFiles) {
    const relPath = relative(appDir, file);
    hash.update(relPath);
    const content = await readFile(file);
    hash.update(content);
  }
  return hash.digest("hex");
}

async function listFilesForPattern(appDir: string, pattern: string): Promise<string[]> {
  if (pattern === "**/*" || pattern === "**") {
    return listFiles(appDir, "", true);
  }
  const wildcardIndex = pattern.search(/[*?]/);
  if (wildcardIndex === -1) {
    return [pattern];
  }
  const staticPrefix = pattern.slice(0, wildcardIndex);
  const slashIndex = staticPrefix.lastIndexOf("/");
  if (slashIndex === -1) {
    return listFiles(appDir, "", pattern.includes("**"));
  }
  const root = staticPrefix.slice(0, slashIndex);
  return listFiles(appDir, root, pattern.includes("**"));
}

async function listFiles(dir: string, prefix = "", recursive = true): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(join(dir, prefix), { withFileTypes: true, encoding: "utf8" });
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const files: string[] = [];
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (recursive) {
        files.push(...await listFiles(dir, rel, true));
      }
    } else if (entry.isSymbolicLink()) {
      try {
        const target = await stat(join(dir, rel));
        if (target.isDirectory()) {
          if (recursive) files.push(...await listFiles(dir, rel, true));
        } else if (target.isFile()) {
          files.push(rel);
        }
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
    } else {
      files.push(rel);
    }
  }
  return files;
}

function matchesGlob(path: string, pattern: string): boolean {
  if (pattern === "**/*" || pattern === "**") return true;
  if (pattern.endsWith("/**")) {
    const prefix = pattern.slice(0, -3);
    return path === prefix || path.startsWith(`${prefix}/`);
  }
  let regex = "^";
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    const next = pattern[i + 1];
    if (char === "*" && next === "*") {
      if (pattern[i + 2] === "/") {
        regex += "(?:.*/)?";
        i += 2;
      } else {
        regex += ".*";
        i += 1;
      }
    } else if (char === "*") {
      regex += "[^/]*";
    } else if (char === "?") {
      regex += "[^/]";
    } else {
      regex += char && /[.+^${}()|[\]\\]/.test(char) ? `\\${char}` : char;
    }
  }
  regex += "$";
  return new RegExp(regex).test(path);
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
