import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { KvStore } from "./app-db-kv.js";

export interface MigrationResult {
  apps: number;
  keys: number;
  errors: string[];
}

export async function migrateJsonToKv(
  homePath: string,
  kvStore: KvStore,
): Promise<MigrationResult> {
  const dataDir = join(homePath, "data");
  if (!existsSync(dataDir)) return { apps: 0, keys: 0, errors: [] };

  const result: MigrationResult = { apps: 0, keys: 0, errors: [] };

  let appDirs: string[];
  try {
    appDirs = readdirSync(dataDir).filter((f) => {
      try {
        return statSync(join(dataDir, f)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch (e) {
    result.errors.push(`Failed to read data directory: ${(e as Error).message}`);
    return result;
  }

  for (const appSlug of appDirs) {
    const appDir = join(dataDir, appSlug);
    let jsonFiles: string[];
    try {
      jsonFiles = readdirSync(appDir).filter((f) => f.endsWith(".json"));
    } catch (e) {
      result.errors.push(`Failed to read ${appSlug}/: ${(e as Error).message}`);
      continue;
    }

    if (jsonFiles.length === 0) continue;
    result.apps++;

    for (const file of jsonFiles) {
      const key = file.replace(/\.json$/, "");
      try {
        const content = readFileSync(join(appDir, file), "utf-8");
        await kvStore.write(appSlug, key, content);
        result.keys++;
      } catch (e) {
        result.errors.push(`${appSlug}/${file}: ${(e as Error).message}`);
      }
    }
  }

  return result;
}
