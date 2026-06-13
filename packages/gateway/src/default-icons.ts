import { lstat, readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";

const SAFE_ICON_FILE = /^([a-zA-Z0-9_-]+)\.(png|svg)$/;
const SKIP_APP_DIRS = new Set(["node_modules"]);

export async function resolveSystemIconPath(homePath: string, requestedFile: string): Promise<string | null> {
  const match = requestedFile.match(SAFE_ICON_FILE);
  if (!match) return null;
  const [, stem, requestedExt] = match;
  const candidates = Array.from(
    new Set([
      `${stem}.${requestedExt}`,
      `${stem}.png`,
      `${stem}.svg`,
      "game-center.png",
      "game.svg",
    ]),
  );
  for (const candidate of candidates) {
    const fullPath = join(homePath, "system/icons", candidate);
    try {
      const iconStat = await lstat(fullPath);
      if (iconStat.isFile()) return fullPath;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn("[icons] failed to stat system icon:", err instanceof Error ? err.message : String(err));
      }
    }
  }
  return null;
}

export async function resolveSystemIconUrl(homePath: string, requestedFile: string): Promise<string | null> {
  const fullPath = await resolveSystemIconPath(homePath, requestedFile);
  return fullPath ? `/files/system/icons/${basename(fullPath)}` : null;
}

export async function resolveDefaultAppIconUrl(homePath: string, slug: string): Promise<string | null> {
  if (!/^[a-zA-Z0-9_-]+$/.test(slug)) return null;
  return findDefaultAppIcon(homePath, join(homePath, "apps"), slug);
}

export async function resolveBundledSystemIconPath(homePath: string, requestedFile: string): Promise<string | null> {
  const match = requestedFile.match(SAFE_ICON_FILE);
  if (!match) return null;
  const [, stem, requestedExt] = match;
  const candidates = Array.from(new Set([`${stem}.${requestedExt}`, `${stem}.png`, `${stem}.svg`]));
  for (const candidate of candidates) {
    const fullPath = join(homePath, "system/icons", candidate);
    try {
      const iconStat = await lstat(fullPath);
      if (iconStat.isFile()) return fullPath;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn("[icons] failed to stat bundled system icon:", err instanceof Error ? err.message : String(err));
      }
    }
  }
  return null;
}

async function findDefaultAppIcon(homePath: string, dir: string, slug: string): Promise<string | null> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn("[icons] failed to scan app icons:", err instanceof Error ? err.message : String(err));
    }
    return null;
  }

  for (const entry of entries) {
    if (SKIP_APP_DIRS.has(entry) || entry.startsWith("_template-")) continue;
    const child = join(dir, entry);
    let childStat;
    try {
      childStat = await lstat(child);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn("[icons] failed to inspect app icon directory:", err instanceof Error ? err.message : String(err));
      }
      continue;
    }
    if (!childStat.isDirectory()) continue;

    const manifestIcon = await readManifestIcon(child, slug);
    if (manifestIcon) {
      const resolved = await resolveSystemIconUrl(homePath, `${manifestIcon}.png`);
      if (resolved) return resolved;
    }

    const nested = await findDefaultAppIcon(homePath, child, slug);
    if (nested) return nested;
  }

  return null;
}

async function readManifestIcon(appDir: string, slug: string): Promise<string | null> {
  try {
    const manifest = JSON.parse(await readFile(join(appDir, "matrix.json"), "utf8")) as {
      slug?: unknown;
      icon?: unknown;
    };
    if (manifest.slug !== slug) return null;
    return typeof manifest.icon === "string" && /^[a-zA-Z0-9_-]+$/.test(manifest.icon)
      ? manifest.icon
      : slug;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn("[icons] failed to read app icon manifest:", err instanceof Error ? err.message : String(err));
    }
    return null;
  }
}
