import { existsSync, readFileSync, appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export interface UsageEntry {
  action: string;
  cost: number;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

export interface UsageSummary {
  total: number;
  byAction: Record<string, number>;
}

export interface LimitResult {
  allowed: boolean;
  remaining: number;
  limit: number;
}

export interface UsagePolicy {
  dailyLimit?: number;
  monthlyLimit?: number;
}

export interface UsageTracker {
  track(action: string, cost: number, metadata?: Record<string, unknown>): void;
  getDaily(date?: string): UsageSummary;
  getMonthly(month?: string): UsageSummary;
  checkLimit(action: string, policy?: UsagePolicy): LimitResult;
}

export function createUsageTracker(homePath: string): UsageTracker {
  const logPath = join(homePath, "system", "logs", "usage.jsonl");

  function readEntries(): UsageEntry[] {
    if (!existsSync(logPath)) return [];
    const content = readFileSync(logPath, "utf-8").trim();
    if (!content) return [];
    return content.split("\n").map((line) => JSON.parse(line) as UsageEntry);
  }

  function summarize(entries: UsageEntry[]): UsageSummary {
    let total = 0;
    const byAction: Record<string, number> = {};
    for (const entry of entries) {
      total += entry.cost;
      byAction[entry.action] = (byAction[entry.action] ?? 0) + entry.cost;
    }
    return { total, byAction };
  }

  function todayStr(): string {
    return new Date().toISOString().slice(0, 10);
  }

  function monthStr(): string {
    return new Date().toISOString().slice(0, 7);
  }

  return {
    track(action: string, cost: number, metadata?: Record<string, unknown>): void {
      const dir = join(homePath, "system", "logs");
      mkdirSync(dir, { recursive: true });
      const entry: UsageEntry = {
        action,
        cost,
        timestamp: new Date().toISOString(),
        ...(metadata ? { metadata } : {}),
      };
      appendFileSync(logPath, JSON.stringify(entry) + "\n");
    },

    getDaily(date?: string): UsageSummary {
      const targetDate = date ?? todayStr();
      const entries = readEntries().filter(
        (e) => e.timestamp.slice(0, 10) === targetDate,
      );
      return summarize(entries);
    },

    getMonthly(month?: string): UsageSummary {
      const targetMonth = month ?? monthStr();
      const entries = readEntries().filter(
        (e) => e.timestamp.slice(0, 7) === targetMonth,
      );
      return summarize(entries);
    },

    checkLimit(action: string, policy?: UsagePolicy): LimitResult {
      if (!policy?.dailyLimit && !policy?.monthlyLimit) {
        return { allowed: true, remaining: Infinity, limit: 0 };
      }

      if (policy.dailyLimit) {
        const daily = this.getDaily();
        const used = daily.byAction[action] ?? 0;
        const remaining = Math.max(0, policy.dailyLimit - used);
        return {
          allowed: used < policy.dailyLimit,
          remaining,
          limit: policy.dailyLimit,
        };
      }

      if (policy.monthlyLimit) {
        const monthly = this.getMonthly();
        const used = monthly.byAction[action] ?? 0;
        const remaining = Math.max(0, policy.monthlyLimit - used);
        return {
          allowed: used < policy.monthlyLimit,
          remaining,
          limit: policy.monthlyLimit,
        };
      }

      return { allowed: true, remaining: Infinity, limit: 0 };
    },
  };
}
