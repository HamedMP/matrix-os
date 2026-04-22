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

export function invalidateManifestCache(): void {
  cache.clear();
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

  const cached = cache.get(slug);
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

  cache.set(slug, { mtimeMs: fileStat.mtimeMs, manifest: result.manifest });

  return { ok: true, manifest: result.manifest };
}
