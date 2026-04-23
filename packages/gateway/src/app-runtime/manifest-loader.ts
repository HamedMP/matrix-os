import { readFile, stat } from "node:fs/promises";
import { join, basename } from "node:path";
import { resolveWithinHome } from "../path-security.js";
import { ManifestError } from "./errors.js";
import { parseManifest, type AppManifest, type ParseResult } from "./manifest-schema.js";

interface CacheEntry {
  mtimeMs: number;
  manifest: AppManifest;
}

const cache = new Map<string, CacheEntry>();
const MANIFEST_CACHE_CAP = 128;

export function invalidateManifestCache(): void {
  cache.clear();
}

function cacheKey(homeDir: string, slug: string): string {
  return `${homeDir}:${slug}`;
}

function getCachedManifest(key: string, mtimeMs: number): AppManifest | null {
  const cached = cache.get(key);
  if (!cached || cached.mtimeMs !== mtimeMs) return null;

  // Refresh insertion order for LRU eviction.
  cache.delete(key);
  cache.set(key, cached);
  return cached.manifest;
}

function setCachedManifest(key: string, entry: CacheEntry): void {
  if (cache.has(key)) {
    cache.delete(key);
  }
  cache.set(key, entry);

  while (cache.size > MANIFEST_CACHE_CAP) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

export async function loadManifest(
  homeDir: string,
  slug: string,
): Promise<ParseResult> {
  const appDir = resolveWithinHome(homeDir, slug);
  if (appDir === null) {
    return {
      ok: false,
      error: new ManifestError("not_found", `slug "${slug}" escapes home directory`),
    };
  }

  const manifestPath = join(appDir, "matrix.json");

  let fileStat;
  try {
    fileStat = await stat(manifestPath);
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        ok: false,
        error: new ManifestError("not_found", `matrix.json not found at ${manifestPath}`),
      };
    }
    return {
      ok: false,
      error: new ManifestError("not_found", `failed to stat ${manifestPath}: ${err instanceof Error ? err.message : String(err)}`),
    };
  }

  const key = cacheKey(homeDir, slug);
  const cached = getCachedManifest(key, fileStat.mtimeMs);
  if (cached) {
    return { ok: true, manifest: cached };
  }

  let rawJson: string;
  try {
    rawJson = await readFile(manifestPath, "utf8");
  } catch (err: unknown) {
    return {
      ok: false,
      error: new ManifestError("not_found", `failed to read ${manifestPath}: ${err instanceof Error ? err.message : String(err)}`),
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    return {
      ok: false,
      error: new ManifestError("invalid_manifest", `invalid JSON in ${manifestPath}`),
    };
  }

  const result = await parseManifest(parsed);
  if (!result.ok) {
    return result;
  }

  const dirName = basename(appDir);
  if (result.manifest.slug !== dirName) {
    return {
      ok: false,
      error: new ManifestError(
        "slug_mismatch",
        `manifest slug "${result.manifest.slug}" does not match directory name "${dirName}"`,
      ),
    };
  }

  setCachedManifest(key, { mtimeMs: fileStat.mtimeMs, manifest: result.manifest });

  return { ok: true, manifest: result.manifest };
}
