import { constants as fsConstants } from "node:fs";
import { open } from "node:fs/promises";
import { join, sep } from "node:path";
import {
  isIgnored as isSyncIgnored,
  mayUnignoreDescendant,
  parseSyncIgnore,
  type SyncIgnorePatterns,
} from "@finnaai/matrix";
import { MIRROR_STATE_DIR } from "./home-mirror-state.js";

export const SYNCIGNORE_PATH = ".syncignore";
export const SYNCIGNORE_MAX_BYTES = 64 * 1024;
const SYNCIGNORE_MAX_PATTERNS = 256;
const SYNCIGNORE_MAX_PATTERN_LENGTH = 512;

// Folders we never push -- big build outputs, transient state, secrets,
// or things that would loop on themselves (the home dir itself when run
// from inside it). These are hard exclusions: owner `.syncignore` negations
// can never re-include them.
const DEFAULT_IGNORE_DIRS = new Set([
  "node_modules",
  ".next",
  ".git",
  ".matrixos",
  "dist",
  "build",
  ".cache",
  ".turbo",
  "coverage",
  ".pnpm-store",
  ".vscode",
  "tmp",
  ".ssh",
  ".gnupg",
  ".aws",
  ".pki",
  ".claude",
  ".codex",
  ".hermes",
  ".local",
  ".npm",
  ".rustup",
  ".elan",
  ".bun",
  ".worktrees",
  ".flox",
  ".direnv",
  ".venv",
  "venv",
  "target",
  ".gradle",
  ".expo",
  MIRROR_STATE_DIR,
]);

const DEFAULT_IGNORE_PATTERNS = [
  /\.log$/i,
  /\.tmp$/i,
  /^\.DS_Store$/,
  /\.env(\..+)?$/,
  /^\.credentials\.json$/i,
  /\.(?:key|pem|token)$/i,
  /^id_(?:rsa|dsa|ecdsa|ed25519).*$/i,
];
// Root files owned by OS template sync, never by the owner's synced tree.
const DEFAULT_IGNORE_ROOT_FILES = new Set([".matrix-version", ".template-manifest.json"]);
const DEFAULT_IGNORE_PATH_PREFIXES = [
  "data/browser-profiles",
  ".config/gh",
  ".config/gcloud",
  ".config/opencode",
  ".pi/agent/auth.json",
  ".cargo/credentials",
  ".cargo/credentials.toml",
];

export function emptyOwnerSyncIgnore(): SyncIgnorePatterns {
  return parseSyncIgnore("");
}

export function ownerSyncIgnoreKey(patterns: SyncIgnorePatterns): string {
  return JSON.stringify(patterns);
}

/** Parse owner policy content, rejecting files that exceed the policy bounds. */
export function parseOwnerSyncIgnore(content: string): SyncIgnorePatterns {
  if (Buffer.byteLength(content, "utf8") > SYNCIGNORE_MAX_BYTES) {
    throw new Error(`.syncignore exceeds ${SYNCIGNORE_MAX_BYTES} bytes`);
  }
  let patternCount = 0;
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const pattern = line.startsWith("!") ? line.slice(1).trim() : line;
    if (!pattern) continue;
    if (pattern.length > SYNCIGNORE_MAX_PATTERN_LENGTH) {
      throw new Error(".syncignore contains an overlong pattern");
    }
    patternCount++;
    if (patternCount > SYNCIGNORE_MAX_PATTERNS) {
      throw new Error(`.syncignore exceeds ${SYNCIGNORE_MAX_PATTERNS} patterns`);
    }
  }
  return parseSyncIgnore(content);
}

export async function loadOwnerSyncIgnore(homeRoot: string): Promise<SyncIgnorePatterns> {
  const path = join(homeRoot, SYNCIGNORE_PATH);
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (err: unknown) {
    if (
      err instanceof Error && "code" in err &&
      ["ENOENT", "ELOOP"].includes(String((err as NodeJS.ErrnoException).code))
    ) {
      return emptyOwnerSyncIgnore();
    }
    throw err;
  }

  try {
    const info = await handle.stat();
    if (!info.isFile()) return emptyOwnerSyncIgnore();
    if (info.size > SYNCIGNORE_MAX_BYTES) {
      throw new Error(`.syncignore exceeds ${SYNCIGNORE_MAX_BYTES} bytes`);
    }
    const bytes = Buffer.alloc(SYNCIGNORE_MAX_BYTES + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > SYNCIGNORE_MAX_BYTES) {
      throw new Error(`.syncignore exceeds ${SYNCIGNORE_MAX_BYTES} bytes`);
    }
    return parseOwnerSyncIgnore(bytes.subarray(0, bytesRead).toString("utf8"));
  } finally {
    await handle.close();
  }
}

function toPosixPath(relPath: string): string {
  return relPath.split(sep).join("/");
}

/** Non-overridable safety exclusions (secrets, build output, loops). */
export function isHardExcluded(relPath: string, extraDirs?: Set<string>): boolean {
  if (!relPath || relPath === ".") return false;
  const normalizedPath = toPosixPath(relPath);
  if (DEFAULT_IGNORE_ROOT_FILES.has(normalizedPath)) return true;
  if (
    DEFAULT_IGNORE_PATH_PREFIXES.some((prefix) =>
      normalizedPath === prefix || normalizedPath.startsWith(`${prefix}/`)
    )
  ) {
    return true;
  }
  const segments = normalizedPath.split("/");
  for (const seg of segments) {
    if (DEFAULT_IGNORE_DIRS.has(seg)) return true;
    if (extraDirs?.has(seg)) return true;
  }
  const last = segments[segments.length - 1] ?? "";
  return DEFAULT_IGNORE_PATTERNS.some((p) => p.test(last));
}

/** File-level decision: should this exact path be excluded from sync? */
export function isHomeMirrorIgnored(
  relPath: string,
  extraDirs: Set<string> | undefined,
  userPatterns: SyncIgnorePatterns,
): boolean {
  // Treat the home root itself ("") as NOT ignored -- otherwise chokidar
  // refuses to descend into it. Only ignore actual entries.
  if (!relPath || relPath === ".") return false;
  if (isHardExcluded(relPath, extraDirs)) return true;
  const normalizedPath = toPosixPath(relPath);
  // The ignore file itself must always remain synchronized so every peer can
  // converge on the same owner policy.
  if (normalizedPath === SYNCIGNORE_PATH) return false;
  return isSyncIgnored(normalizedPath, userPatterns);
}

/**
 * Traversal decision for walkers and watchers: may this path be skipped
 * without descending into it? Hard exclusions always prune. An owner-ignored
 * directory stays traversable while a negation could re-include a descendant,
 * so callers must still apply `isHomeMirrorIgnored` to each file they find.
 */
export function shouldPruneHomeMirrorPath(
  relPath: string,
  extraDirs: Set<string> | undefined,
  userPatterns: SyncIgnorePatterns,
): boolean {
  if (!isHomeMirrorIgnored(relPath, extraDirs, userPatterns)) return false;
  if (isHardExcluded(relPath, extraDirs)) return true;
  return !mayUnignoreDescendant(toPosixPath(relPath), userPatterns);
}
