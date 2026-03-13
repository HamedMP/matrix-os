import { readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { loadAppMeta, type AppMeta } from "@matrix-os/kernel";
import { loadAppManifest } from "./app-manifest.js";

export interface AppEntry extends AppMeta {
  file: string;
  path: string;
}

export function listApps(homePath: string): AppEntry[] {
  const appsDir = join(homePath, "apps");
  if (!existsSync(appsDir)) return [];

  const result: AppEntry[] = [];
  const seen = new Set<string>();

  scanAppsDir(appsDir, "", result, seen);

  return result.sort((a, b) => a.name.localeCompare(b.name));
}

function scanAppsDir(
  baseDir: string,
  prefix: string,
  result: AppEntry[],
  seen: Set<string>,
): void {
  const dir = prefix ? join(baseDir, prefix) : baseDir;
  const entries = readdirSync(dir);

  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const relativePath = prefix ? `${prefix}/${entry}` : entry;

    if (statSync(fullPath).isDirectory()) {
      const manifest = loadAppManifest(fullPath);
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
      scanAppsDir(baseDir, relativePath, result, seen);
      continue;
    }

    if (!prefix && entry.endsWith(".html")) {
      const slug = entry.replace(/\.html$/, "");
      if (seen.has(slug)) continue;
      seen.add(slug);
      const meta = loadAppMeta(baseDir, entry);
      result.push({
        ...meta,
        file: entry,
        path: `/files/apps/${entry}`,
      });
    }
  }
}
