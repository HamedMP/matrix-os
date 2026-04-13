import { readFile } from "node:fs/promises";
import { join } from "node:path";
import picomatch from "picomatch";

export const DEFAULT_PATTERNS: readonly string[] = [
  "node_modules/",
  ".next/",
  ".venv/",
  "__pycache__/",
  "dist/",
  "build/",
  ".cache/",
  "*.sqlite",
  "*.db",
  "system/logs/",
  "system/matrix.db*",
  ".git/",
  ".trash/",
  ".DS_Store",
  "Thumbs.db",
];

export function parseSyncIgnore(content: string): string[] {
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

export async function loadSyncIgnore(syncRoot: string): Promise<string[]> {
  let userPatterns: string[] = [];
  try {
    const content = await readFile(join(syncRoot, ".syncignore"), "utf-8");
    userPatterns = parseSyncIgnore(content);
  } catch (err: unknown) {
    if (
      !(err instanceof Error) ||
      (err as NodeJS.ErrnoException).code !== "ENOENT"
    ) {
      throw err;
    }
  }

  const merged = [...DEFAULT_PATTERNS];
  for (const pattern of userPatterns) {
    if (!merged.includes(pattern)) {
      merged.push(pattern);
    }
  }
  return merged;
}

export function isIgnored(filePath: string, patterns: string[]): boolean {
  let ignored = false;

  for (const pattern of patterns) {
    const negated = pattern.startsWith("!");
    const raw = negated ? pattern.slice(1) : pattern;

    if (matchesPattern(filePath, raw)) {
      ignored = !negated;
    }
  }

  return ignored;
}

function matchesPattern(filePath: string, pattern: string): boolean {
  const isDir = pattern.endsWith("/");
  const cleanPattern = isDir ? pattern.slice(0, -1) : pattern;

  if (isDir) {
    // Directory pattern: match the dir itself or anything under it
    // If pattern has a slash (path-specific), match from start
    if (cleanPattern.includes("/")) {
      return (
        filePath === cleanPattern ||
        filePath.startsWith(cleanPattern + "/")
      );
    }
    // Otherwise match the directory name anywhere in the path
    const segments = filePath.split("/");
    for (let i = 0; i < segments.length; i++) {
      if (segments[i] === cleanPattern) {
        return true;
      }
    }
    return false;
  }

  // File/glob pattern
  if (pattern.includes("/")) {
    // Path-specific: match from the start using glob
    return picomatch.isMatch(filePath, pattern);
  }

  // Basename match: check against every segment and the full path
  const basename = filePath.split("/").pop() ?? filePath;
  return picomatch.isMatch(basename, cleanPattern);
}
