import { readdir, readFile, realpath } from "node:fs/promises";
import { join, sep } from "node:path";
import { ManifestError } from "./errors.js";
import { parseManifest, SAFE_SLUG, type AppManifest } from "./manifest-schema.js";

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  ".next",
  ".cache",
  ".vite",
  "_template-next",
  "_template-vite",
]);

export interface AppManifestIndexEntry {
  slug: string;
  relativePath: string;
  appDir: string;
  manifestPath: string;
  manifest: AppManifest;
}

const APP_INDEX_CACHE_TTL_MS = 1_000;
const appIndexCache = new Map<string, { expiresAt: number; entries: AppManifestIndexEntry[] }>();

export function invalidateAppIndexCache(): void {
  appIndexCache.clear();
}

function isExpectedFsError(err: unknown): boolean {
  if (!err || typeof err !== "object" || !("code" in err)) return false;
  return ["ENOENT", "EACCES", "EPERM", "ENOTDIR", "ELOOP"].includes(String(err.code));
}

function isMissingManifestError(err: unknown): boolean {
  if (!err || typeof err !== "object" || !("code" in err)) return false;
  return ["ENOENT", "ENOTDIR"].includes(String(err.code));
}

function isWithinRealPath(baseReal: string, candidateReal: string): boolean {
  return candidateReal === baseReal || candidateReal.startsWith(`${baseReal}${sep}`);
}

function logAppIndexSkip(entry: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  console.warn(`[apps] Skipping unreadable app entry ${entry}: ${message}`);
}

async function readManifestCandidate(
  appsDir: string,
  relativePath: string,
): Promise<AppManifestIndexEntry | null> {
  const appDir = join(appsDir, relativePath);
  const manifestPath = join(appDir, "matrix.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (err: unknown) {
    if (isMissingManifestError(err)) {
      return null;
    }
    if (err instanceof SyntaxError || isExpectedFsError(err)) {
      logAppIndexSkip(relativePath, err);
      return null;
    }
    throw err;
  }

  const result = await parseManifest(parsed);
  if (!result.ok) {
    logAppIndexSkip(relativePath, result.error);
    return null;
  }

  return {
    slug: result.manifest.slug,
    relativePath,
    appDir,
    manifestPath,
    manifest: result.manifest,
  };
}

async function scanManifestCandidates(
  appsDir: string,
  prefix = "",
  result: AppManifestIndexEntry[] = [],
): Promise<AppManifestIndexEntry[]> {
  const dir = prefix ? join(appsDir, prefix) : appsDir;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err: unknown) {
    if (isExpectedFsError(err)) {
      logAppIndexSkip(prefix || ".", err);
      return result;
    }
    throw err;
  }

  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) continue;
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;

    const manifest = await readManifestCandidate(appsDir, relativePath);
    if (manifest) result.push(manifest);

    await scanManifestCandidates(appsDir, relativePath, result);
  }

  return result;
}

async function getManifestCandidates(appsDir: string): Promise<AppManifestIndexEntry[]> {
  const now = Date.now();
  const cached = appIndexCache.get(appsDir);
  if (cached && cached.expiresAt > now) {
    return cached.entries;
  }
  const entries = await scanManifestCandidates(appsDir);
  appIndexCache.set(appsDir, { entries, expiresAt: now + APP_INDEX_CACHE_TTL_MS });
  return entries;
}

export async function listUniqueAppManifests(appsDir: string): Promise<AppManifestIndexEntry[]> {
  const candidates = await getManifestCandidates(appsDir);
  const bySlug = new Map<string, AppManifestIndexEntry[]>();
  for (const candidate of candidates) {
    const bucket = bySlug.get(candidate.slug) ?? [];
    bucket.push(candidate);
    bySlug.set(candidate.slug, bucket);
  }

  const unique: AppManifestIndexEntry[] = [];
  for (const [slug, entries] of [...bySlug.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    entries.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
    if (entries.length > 1) {
      console.warn(
        `[apps] Skipping duplicate app slug ${slug}: ${entries.map((e) => e.relativePath).join(", ")}`,
      );
      continue;
    }
    unique.push(entries[0]);
  }
  return unique;
}

export async function resolveAppBySlug(
  appsDir: string,
  slug: string,
): Promise<
  | { ok: true; entry: AppManifestIndexEntry }
  | { ok: false; error: ManifestError }
> {
  if (!SAFE_SLUG.test(slug)) {
    return { ok: false, error: new ManifestError("not_found", "invalid slug") };
  }

  const candidates = (await getManifestCandidates(appsDir))
    .filter((entry) => entry.slug === slug)
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath));

  if (candidates.length === 0) {
    try {
      const appDir = join(appsDir, slug);
      const manifestPath = join(appDir, "matrix.json");
      const direct = JSON.parse(await readFile(manifestPath, "utf8"));
      const parsed = await parseManifest(direct);
      if (!parsed.ok) return { ok: false, error: parsed.error };
      if (parsed.manifest.slug === slug) {
        const [appsReal, appReal] = await Promise.all([realpath(appsDir), realpath(appDir)]);
        if (!isWithinRealPath(appsReal, appReal)) {
          return {
            ok: false,
            error: new ManifestError("not_found", `app slug "${slug}" escapes apps directory`),
          };
        }
        return {
          ok: true,
          entry: {
            slug,
            relativePath: slug,
            appDir,
            manifestPath,
            manifest: parsed.manifest,
          },
        };
      }
    } catch (err: unknown) {
      if (err instanceof SyntaxError) {
        return {
          ok: false,
          error: new ManifestError("invalid_manifest", `invalid JSON for app slug "${slug}"`),
        };
      }
      if (!isExpectedFsError(err)) throw err;
    }
    return { ok: false, error: new ManifestError("not_found", `app slug "${slug}" not found`) };
  }
  if (candidates.length > 1) {
    return {
      ok: false,
      error: new ManifestError("invalid_manifest", `duplicate app slug "${slug}"`),
    };
  }

  const [appsReal, appReal] = await Promise.all([
    realpath(appsDir),
    realpath(candidates[0].appDir),
  ]);
  if (!isWithinRealPath(appsReal, appReal)) {
    return {
      ok: false,
      error: new ManifestError("not_found", `app slug "${slug}" escapes apps directory`),
    };
  }

  return { ok: true, entry: candidates[0] };
}
