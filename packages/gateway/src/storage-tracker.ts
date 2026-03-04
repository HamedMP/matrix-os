import { existsSync, readdirSync, statSync, appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export interface StorageUsage {
  disk: number;
  sqlite: Record<string, number>;
  timestamp: string;
}

export interface StorageTracker {
  measure(): StorageUsage;
  record(): void;
}

function dirSize(dirPath: string): number {
  if (!existsSync(dirPath)) return 0;
  let total = 0;

  try {
    const entries = readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dirPath, entry.name);
      if (entry.isDirectory()) {
        total += dirSize(fullPath);
      } else if (entry.isFile()) {
        total += statSync(fullPath).size;
      }
    }
  } catch {
    // permission errors, etc.
  }

  return total;
}

function sqliteSizes(dataDir: string): Record<string, number> {
  const sizes: Record<string, number> = {};
  if (!existsSync(dataDir)) return sizes;

  try {
    const apps = readdirSync(dataDir, { withFileTypes: true });
    for (const app of apps) {
      if (!app.isDirectory()) continue;
      const dbPath = join(dataDir, app.name, "db.sqlite");
      if (existsSync(dbPath)) {
        sizes[app.name] = statSync(dbPath).size;
      }
    }
  } catch {
    // ignore
  }

  return sizes;
}

export function createStorageTracker(homePath: string): StorageTracker {
  return {
    measure(): StorageUsage {
      return {
        disk: dirSize(homePath),
        sqlite: sqliteSizes(join(homePath, "data")),
        timestamp: new Date().toISOString(),
      };
    },

    record(): void {
      const usage = this.measure();
      const logsDir = join(homePath, "system", "logs");
      if (!existsSync(logsDir)) mkdirSync(logsDir, { recursive: true });
      const logPath = join(logsDir, "storage.jsonl");
      appendFileSync(logPath, JSON.stringify(usage) + "\n");
    },
  };
}
