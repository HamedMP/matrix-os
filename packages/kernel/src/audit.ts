import { existsSync, mkdirSync, renameSync, readdirSync, unlinkSync, statSync } from "node:fs";
import * as fs from "node:fs";
import { join } from "node:path";

export interface AuditEntry {
  op: "write" | "delete" | "mkdir";
  path: string;
  sizeBytes?: number;
  actor: string;
}

export interface AuditLogEntry extends AuditEntry {
  timestamp: string;
}

export interface AuditLogger {
  log(entry: AuditEntry): void;
}
const appendFileNow = fs.appendFileSync as (
  path: string,
  data: string,
) => void;

export function createAuditLogger(logDir: string): AuditLogger {
  const auditPath = join(logDir, "audit.jsonl");

  return {
    log(entry: AuditEntry) {
      if (!existsSync(logDir)) {
        mkdirSync(logDir, { recursive: true });
      }
      const logEntry: AuditLogEntry = {
        ...entry,
        timestamp: new Date().toISOString(),
      };
      appendFileNow(auditPath, JSON.stringify(logEntry) + "\n");
    },
  };
}

export function rotateActivityLog(systemDir: string): string | null {
  const activityPath = join(systemDir, "activity.log");
  if (!existsSync(activityPath)) return null;

  const date = new Date().toISOString().slice(0, 10);
  const rotatedPath = join(systemDir, `activity-${date}.log`);
  renameSync(activityPath, rotatedPath);
  return rotatedPath;
}

export function cleanOldLogs(logsDir: string, retentionDays: number): void {
  if (!existsSync(logsDir)) return;

  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const files = readdirSync(logsDir);

  for (const file of files) {
    const filePath = join(logsDir, file);
    try {
      const stat = statSync(filePath);
      if (stat.isFile() && stat.mtimeMs < cutoff) {
        unlinkSync(filePath);
      }
    } catch (err: unknown) {
      console.warn("[audit] Could not clean old log:", err instanceof Error ? err.message : String(err));
    }
  }
}
