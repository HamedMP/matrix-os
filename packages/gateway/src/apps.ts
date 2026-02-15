import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { loadAppMeta, type AppMeta } from "@matrix-os/kernel";

export interface AppEntry extends AppMeta {
  file: string;
  path: string;
}

export function listApps(homePath: string): AppEntry[] {
  const appsDir = join(homePath, "apps");
  if (!existsSync(appsDir)) return [];

  const files = readdirSync(appsDir).filter((f) => f.endsWith(".html"));

  return files
    .map((file) => {
      const meta = loadAppMeta(appsDir, file);
      return {
        ...meta,
        file,
        path: `/files/apps/${file}`,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}
