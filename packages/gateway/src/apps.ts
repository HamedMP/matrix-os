import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { loadAppMeta, type AppMeta } from "@matrix-os/kernel";
import { loadAppManifest } from "./app-manifest.js";

export interface AppEntry extends AppMeta {
  file: string;
  path: string;
}

export async function listApps(homePath: string): Promise<AppEntry[]> {
  const appsDir = join(homePath, "apps");

  const result: AppEntry[] = [];
  const seen = new Set<string>();

  await scanAppsDir(appsDir, "", result, seen);

  return result.sort((a, b) => a.name.localeCompare(b.name));
}

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

function scanAppsDir(
  baseDir: string,
  prefix: string,
  result: AppEntry[],
  seen: Set<string>,
): Promise<void> {
  const dir = prefix ? join(baseDir, prefix) : baseDir;
  return readdir(dir, { withFileTypes: true })
    .then(async (entries) => {
      for (const entry of entries) {
        if (SKIP_DIRS.has(entry.name)) continue;

        const fullPath = join(dir, entry.name);
        const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;

        if (entry.isDirectory()) {
          const manifest = safeLoadAppManifest(fullPath, relativePath);
          if (manifest) {
            if (!seen.has(relativePath)) {
              seen.add(relativePath);
              result.push({
                name: manifest.name,
                description: manifest.description,
                icon: manifest.icon,
                category: manifest.category,
                author: manifest.author,
                version: manifest.version,
                file: `${relativePath}/index.html`,
                path: `/files/apps/${relativePath}/index.html`,
              });
            }
          }
          // Always recurse to discover nested apps (e.g. games/snake inside games/)
          await scanAppsDir(baseDir, relativePath, result, seen);
          continue;
        }

        if (!prefix && entry.isFile() && entry.name.endsWith(".html")) {
          const slug = entry.name.replace(/\.html$/, "");
          if (seen.has(slug)) continue;
          const meta = safeLoadAppMeta(baseDir, entry.name);
          seen.add(slug);
          result.push({
            ...meta,
            file: entry.name,
            path: `/files/apps/${entry.name}`,
          });
        }
      }
    })
    .catch((err: unknown) => {
      if (isExpectedFsScanError(err)) {
        logAppScanSkip(prefix || ".", err);
        return;
      }
      logAppScanSkip(prefix || ".", err);
    });
}

function safeLoadAppManifest(appDir: string, relativePath: string): ReturnType<typeof loadAppManifest> {
  try {
    return loadAppManifest(appDir);
  } catch (err: unknown) {
    logAppScanSkip(relativePath, err);
    return null;
  }
}

function safeLoadAppMeta(appsDir: string, entry: string): AppMeta {
  try {
    return loadAppMeta(appsDir, entry);
  } catch (err: unknown) {
    logAppScanSkip(entry, err);
    return { name: entry.replace(/\.html$/, ""), category: "utility" };
  }
}

function isExpectedFsScanError(err: unknown): boolean {
  if (!err || typeof err !== "object" || !("code" in err)) return false;
  return ["ENOENT", "EACCES", "EPERM", "ENOTDIR", "ELOOP"].includes(String(err.code));
}

function logAppScanSkip(entry: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  console.warn(`[apps] Skipping unreadable app entry ${entry}: ${message}`);
}
