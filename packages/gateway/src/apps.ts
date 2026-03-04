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

  const entries = readdirSync(appsDir);
  const result: AppEntry[] = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    const fullPath = join(appsDir, entry);

    if (statSync(fullPath).isDirectory()) {
      const manifest = loadAppManifest(fullPath);
      if (manifest) {
        const slug = entry;
        if (!seen.has(slug)) {
          seen.add(slug);
          result.push({
            name: manifest.name,
            description: manifest.description,
            icon: manifest.icon,
            category: manifest.category,
            author: manifest.author,
            version: manifest.version,
            file: `${slug}/index.html`,
            path: `/files/apps/${slug}/index.html`,
          });
        }
      }
      continue;
    }

    if (entry.endsWith(".html")) {
      const slug = entry.replace(/\.html$/, "");
      if (seen.has(slug)) continue;
      seen.add(slug);
      const meta = loadAppMeta(appsDir, entry);
      result.push({
        ...meta,
        file: entry,
        path: `/files/apps/${entry}`,
      });
    }
  }

  return result.sort((a, b) => a.name.localeCompare(b.name));
}
