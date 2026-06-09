import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import type { AutoCleanupPolicy, CleanupHistoryEntry } from "./types.js";

const HISTORY_LIMIT = 100;
const DEFAULT_POLICY: Omit<AutoCleanupPolicy, "lastUpdatedAt"> = {
  enabled: false,
  allowedTypes: [],
  gracePeriodSeconds: 1800,
  maxActionsPerHour: 3,
};

export class ActivityHistoryStore {
  private readonly filePath: string;

  constructor(options: { homePath: string }) {
    this.filePath = join(options.homePath, "system", "activity-monitor-history.json");
  }

  async append(entry: Omit<CleanupHistoryEntry, "id" | "createdAt">): Promise<CleanupHistoryEntry> {
    const current = await this.readAll();
    const nextEntry: CleanupHistoryEntry = {
      ...entry,
      id: `hist_${randomUUID()}`,
      createdAt: new Date().toISOString(),
    };
    await writeJsonAtomic(this.filePath, [nextEntry, ...current].slice(0, HISTORY_LIMIT));
    return nextEntry;
  }

  async list(query: { limit: number; cursor?: string }): Promise<{ entries: CleanupHistoryEntry[]; nextCursor: string | null }> {
    const entries = await this.readAll();
    const safeStart = query.cursor ? entries.findIndex((entry) => entry.id === query.cursor) + 1 : 0;
    if (query.cursor && safeStart === 0) return { entries: [], nextCursor: null };
    const page = entries.slice(safeStart, safeStart + query.limit);
    const nextIndex = safeStart + page.length;
    return {
      entries: page,
      nextCursor: nextIndex < entries.length && page.length > 0 ? page[page.length - 1]?.id ?? null : null,
    };
  }

  private async readAll(): Promise<CleanupHistoryEntry[]> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8"));
      return Array.isArray(parsed) ? parsed.slice(0, HISTORY_LIMIT).filter(isHistoryEntry) : [];
    } catch (err) {
      if (isMissingFile(err)) return [];
      console.warn("[system-activity] failed to read cleanup history:", err instanceof Error ? err.message : String(err));
      return [];
    }
  }
}

export class AutoCleanupPolicyStore {
  private readonly filePath: string;

  constructor(options: { homePath: string }) {
    this.filePath = join(options.homePath, "system", "activity-monitor-policy.json");
  }

  async read(): Promise<AutoCleanupPolicy> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8"));
      if (isPolicy(parsed)) return parsed;
    } catch (err) {
      if (!isMissingFile(err)) {
        console.warn("[system-activity] failed to read cleanup policy:", err instanceof Error ? err.message : String(err));
      }
    }
    return { ...DEFAULT_POLICY, lastUpdatedAt: new Date(0).toISOString() };
  }

  async save(policy: Omit<AutoCleanupPolicy, "lastUpdatedAt">): Promise<AutoCleanupPolicy> {
    const next: AutoCleanupPolicy = {
      enabled: policy.enabled,
      allowedTypes: [...policy.allowedTypes],
      gracePeriodSeconds: policy.gracePeriodSeconds,
      maxActionsPerHour: policy.maxActionsPerHour,
      lastUpdatedAt: new Date().toISOString(),
    };
    await writeJsonAtomic(this.filePath, next);
    return next;
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmpPath = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
  await rename(tmpPath, path);
}

function isMissingFile(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT";
}

function isHistoryEntry(value: unknown): value is CleanupHistoryEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as CleanupHistoryEntry;
  return typeof entry.id === "string"
    && typeof entry.createdAt === "string"
    && typeof entry.actionType === "string"
    && typeof entry.targetLabel === "string"
    && typeof entry.result === "string"
    && typeof entry.reasonCode === "string";
}

function isPolicy(value: unknown): value is AutoCleanupPolicy {
  if (typeof value !== "object" || value === null) return false;
  const policy = value as AutoCleanupPolicy;
  return typeof policy.enabled === "boolean"
    && Array.isArray(policy.allowedTypes)
    && typeof policy.gracePeriodSeconds === "number"
    && typeof policy.maxActionsPerHour === "number"
    && typeof policy.lastUpdatedAt === "string";
}
