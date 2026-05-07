import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { ManifestError } from "./errors.js";
import { parseManifest, type AppManifest, type ParseResult } from "./manifest-schema.js";
import { invalidateAppIndexCache, resolveAppBySlug } from "./app-index.js";

interface CacheEntry {
  mtimeMs: number;
  manifest: AppManifest;
}

const MAX_MANIFEST_CACHE_ENTRIES = 256;
const cache = new Map<string, CacheEntry>();

export function invalidateManifestCache(): void {
  cache.clear();
  invalidateAppIndexCache();
}

function getCacheKey(homeDir: string, slug: string): string {
  return `${homeDir}\0${slug}`;
}

function getCachedManifest(cacheKey: string): CacheEntry | undefined {
  const cached = cache.get(cacheKey);
  if (!cached) return undefined;
  cache.delete(cacheKey);
  cache.set(cacheKey, cached);
  return cached;
}

function setCachedManifest(cacheKey: string, entry: CacheEntry): void {
  if (cache.has(cacheKey)) {
    cache.delete(cacheKey);
  }
  cache.set(cacheKey, entry);
  while (cache.size > MAX_MANIFEST_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

export async function loadManifest(
  appsDir: string,
  slug: string,
): Promise<ParseResult> {
  const resolved = await resolveAppBySlug(appsDir, slug);
  if (!resolved.ok) return resolved;
  const appDir = resolved.entry.appDir;

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

  const cacheKey = getCacheKey(appsDir, slug);
  const cached = getCachedManifest(cacheKey);
  if (cached && cached.mtimeMs === fileStat.mtimeMs) {
    return { ok: true, manifest: cached.manifest };
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

  if (result.manifest.slug !== slug) {
    return {
      ok: false,
      error: new ManifestError(
        "slug_mismatch",
        `manifest slug "${result.manifest.slug}" does not match requested slug "${slug}"`,
      ),
    };
  }

  setCachedManifest(cacheKey, { mtimeMs: fileStat.mtimeMs, manifest: result.manifest });

  return { ok: true, manifest: result.manifest };
}
