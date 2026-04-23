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

export interface SyncIgnorePatterns {
  /** Positive match patterns (file/dir globs) */
  patterns: string[];
  /** Negation patterns (without the leading !) */
  negations: string[];
}

/**
 * Parse a .syncignore file content string into structured patterns.
 * Always includes DEFAULT_PATTERNS. Custom patterns are merged on top.
 */
export function parseSyncIgnore(content: string): SyncIgnorePatterns {
  const patterns = [...DEFAULT_PATTERNS];
  const negations: string[] = [];

  const lines = content.split("\n");
  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (line === "" || line.startsWith("#")) {
      continue;
    }

    if (line.startsWith("!")) {
      const negated = line.slice(1).trim();
      if (negated) {
        negations.push(negated);
      }
      continue;
    }

    if (!patterns.includes(line)) {
      patterns.push(line);
    }
  }

  return { patterns, negations };
}

/**
 * Check whether a relative file path should be ignored based on parsed patterns.
 *
 * Follows .gitignore semantics:
 * - Patterns ending with / match directories (and anything inside them)
 * - Patterns without / are matched against the basename at any depth
 * - Patterns with / (not trailing) are matched against the full path
 * - Negation patterns (!) un-ignore a previously ignored file
 */
export function isIgnored(
  filePath: string,
  { patterns, negations }: SyncIgnorePatterns,
): boolean {
  const segments = filePath.split("/");
  const basename = segments[segments.length - 1] ?? "";

  let ignored = false;

  for (const pattern of patterns) {
    if (matchesPattern(filePath, segments, basename, pattern)) {
      ignored = true;
      break;
    }
  }

  if (ignored && negations.length > 0) {
    for (const negation of negations) {
      if (matchesPattern(filePath, segments, basename, negation)) {
        return false;
      }
    }
  }

  return ignored;
}

function matchesPattern(
  filePath: string,
  segments: string[],
  basename: string,
  pattern: string,
): boolean {
  // Directory pattern (trailing /)
  if (pattern.endsWith("/")) {
    const dirName = pattern.slice(0, -1);

    // Check if the pattern contains a path separator (like "system/logs")
    if (dirName.includes("/")) {
      // Match as a path prefix
      if (
        filePath.startsWith(dirName + "/") ||
        filePath === dirName
      ) {
        return true;
      }
      return false;
    }

    // Simple directory name: match any segment in the path
    for (const segment of segments) {
      if (segment === dirName) {
        return true;
      }
    }
    return false;
  }

  // Pattern with path components (like "system/matrix.db*")
  if (pattern.includes("/")) {
    return picomatch.isMatch(filePath, pattern, { dot: true });
  }

  // Simple filename/glob pattern: match against basename at any depth
  return picomatch.isMatch(basename, pattern, { dot: true });
}

/**
 * Load and parse the .syncignore file from the given sync root directory.
 * Returns default patterns if no .syncignore file exists.
 */
export async function loadSyncIgnore(
  syncRoot: string,
): Promise<SyncIgnorePatterns> {
  const syncignorePath = join(syncRoot, ".syncignore");

  let content: string;
  try {
    content = await readFile(syncignorePath, "utf-8");
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      "code" in err &&
      (err as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return parseSyncIgnore("");
    }
    throw err;
  }

  return parseSyncIgnore(content);
}
