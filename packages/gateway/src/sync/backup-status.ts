import { execFile } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import {
  BackupAttemptSchema,
  BackupReceiptSchema,
  BackupStatusSchema,
  deriveBackupFreshness,
  type BackupStatus,
} from "@matrix-os/contracts";

const MAX_STATUS_BYTES = 64 * 1024;
const SYSTEMCTL_TIMEOUT_MS = 2_000;

export interface BackupTimerState {
  enabled: boolean | null;
  active: boolean | null;
  nextDueAt: number | null;
}

async function readBoundedJson(path: string): Promise<unknown | null> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_STATUS_BYTES) {
      return null;
    }
    return JSON.parse(await readFile(path, "utf8"));
  } catch (err: unknown) {
    if (
      err instanceof SyntaxError
      || (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT")
    ) {
      return null;
    }
    throw err;
  }
}

export async function readBackupTimerState(): Promise<BackupTimerState> {
  return new Promise((resolve) => {
    execFile(
      "systemctl",
      [
        "show",
        "matrix-db-backup.timer",
        "--property=LoadState,UnitFileState,ActiveState,NextElapseUSecRealtime",
      ],
      { timeout: SYSTEMCTL_TIMEOUT_MS, maxBuffer: 16 * 1024, encoding: "utf8" },
      (error, stdout) => {
        if (error) {
          resolve({ enabled: null, active: null, nextDueAt: null });
          return;
        }
        const fields = Object.fromEntries(stdout.trim().split("\n").map((line) => {
          const split = line.indexOf("=");
          return split < 0 ? [line, ""] : [line.slice(0, split), line.slice(split + 1)];
        }));
        const next = Date.parse(fields.NextElapseUSecRealtime ?? "");
        resolve({
          enabled: fields.LoadState === "loaded"
            ? fields.UnitFileState === "enabled"
            : fields.LoadState === "not-found" ? false : null,
          active: fields.ActiveState ? fields.ActiveState === "active" : null,
          nextDueAt: Number.isFinite(next) ? next : null,
        });
      },
    );
  });
}

export async function loadBackupStatus(input: {
  statusDir?: string;
  now?: number;
  timerState?: () => Promise<BackupTimerState>;
} = {}): Promise<BackupStatus> {
  const statusDir = input.statusDir ?? "/var/lib/matrix/db/backup-status";
  const observedAt = input.now ?? Date.now();
  const [attemptRaw, successRaw, scheduler] = await Promise.all([
    readBoundedJson(`${statusDir}/last-attempt.json`),
    readBoundedJson(`${statusDir}/last-success.json`),
    (input.timerState ?? readBackupTimerState)(),
  ]);
  const attempt = BackupAttemptSchema.safeParse(attemptRaw);
  const success = BackupReceiptSchema.safeParse(successRaw);
  const lastAttempt = attempt.success ? attempt.data : null;
  const lastSuccess = success.success ? success.data : null;
  const storageReachability = lastAttempt?.outcome === "success"
    ? "reachable"
    : lastAttempt?.errorCode?.startsWith("storage_")
      ? "unreachable"
      : "unknown";
  return BackupStatusSchema.parse({
    schemaVersion: 1,
    scheduler,
    lastAttempt,
    lastSuccess,
    storageReachability,
    freshness: deriveBackupFreshness(lastSuccess?.completedAt ?? null, observedAt),
    observedAt,
  });
}
