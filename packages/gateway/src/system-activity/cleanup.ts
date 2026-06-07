import { randomUUID } from "node:crypto";
import { ActivityConflictError, ActivityForbiddenError } from "./types.js";
import type {
  CleanupAction,
  CleanupActionResult,
  CleanupCandidate,
  CleanupHistoryEntry,
  ProcessSummary,
} from "./types.js";
import type { ActivityHistoryStore } from "./history.js";

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_CANDIDATES = 100;

interface CandidateRecord {
  public: CleanupCandidate;
  pid?: number;
  reasonCode: string;
  createdAtMs: number;
}

export class CleanupCandidateRegistry {
  private readonly candidates = new Map<string, CandidateRecord>();
  private readonly ttlMs: number;
  private readonly maxCandidates: number;

  constructor(options: { ttlMs?: number; maxCandidates?: number } = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.maxCandidates = options.maxCandidates ?? DEFAULT_MAX_CANDIDATES;
  }

  classify(processes: ProcessSummary[], now = Date.now(), options: { minElapsedSeconds?: number } = {}): CleanupCandidate[] {
    this.evictExpired(now);
    const suggestions: CleanupCandidate[] = [];
    const minElapsedSeconds = options.minElapsedSeconds ?? 30 * 24 * 60 * 60;
    for (const process of processes) {
      if (
        process.classification === "app_server"
        && process.activeConnections === 0
        && process.elapsedSeconds >= minElapsedSeconds
        && process.pid !== undefined
      ) {
        suggestions.push(this.register({
          pid: process.pid,
          type: "stop_stale_app_server",
          targetLabel: process.displayName,
          reason: "No active connections and the app server appears stale.",
          confidence: "high",
          risk: "low",
          estimatedReclaimBytes: process.rssBytes,
          reasonCode: "stale_app_server_no_connections",
          now,
        }));
      }
    }
    return suggestions;
  }

  get(action: CleanupAction, now = Date.now()): CandidateRecord {
    this.evictExpired(now);
    const record = this.candidates.get(action.candidateId);
    if (!record) throw new ActivityConflictError("candidate expired");
    if (record.public.type !== action.type) throw new ActivityConflictError("candidate type mismatch");
    if (record.public.confirmationToken !== action.confirmationToken) {
      throw new ActivityConflictError("confirmation mismatch");
    }
    if (action.mode === "automatic" && !isAutomaticType(action.type)) {
      throw new ActivityForbiddenError("manual-only cleanup action");
    }
    return record;
  }

  clear(): void {
    this.candidates.clear();
  }

  size(now = Date.now()): number {
    this.evictExpired(now);
    return this.candidates.size;
  }

  private register(input: {
    pid?: number;
    type: CleanupCandidate["type"];
    targetLabel: string;
    reason: string;
    confidence: CleanupCandidate["confidence"];
    risk: CleanupCandidate["risk"];
    estimatedReclaimBytes?: number;
    reasonCode: string;
    now: number;
  }): CleanupCandidate {
    const candidateId = `cand_${randomUUID()}`;
    const confirmationToken = `confirm_${randomUUID()}`;
    const publicCandidate: CleanupCandidate = {
      candidateId,
      type: input.type,
      targetLabel: sanitizeLabel(input.targetLabel),
      reason: input.reason,
      confidence: input.confidence,
      risk: input.risk,
      estimatedReclaimBytes: input.estimatedReclaimBytes,
      requiresConfirmation: true,
      confirmationToken,
      expiresAt: new Date(input.now + this.ttlMs).toISOString(),
    };
    this.candidates.set(candidateId, {
      public: publicCandidate,
      pid: input.pid,
      reasonCode: input.reasonCode,
      createdAtMs: input.now,
    });
    this.evictOverflow();
    return publicCandidate;
  }

  private evictExpired(now: number): void {
    for (const [id, record] of this.candidates) {
      if (now - record.createdAtMs >= this.ttlMs) this.candidates.delete(id);
    }
  }

  private evictOverflow(): void {
    while (this.candidates.size > this.maxCandidates) {
      const oldest = this.candidates.keys().next().value as string | undefined;
      if (!oldest) return;
      this.candidates.delete(oldest);
    }
  }
}

export async function executeCleanupAction(options: {
  action: CleanupAction;
  registry: CleanupCandidateRegistry;
  history: ActivityHistoryStore;
  killProcess?: (pid: number, signal: NodeJS.Signals | 0) => void;
}): Promise<CleanupActionResult> {
  const killProcess = options.killProcess ?? process.kill.bind(process);
  const record = options.registry.get(options.action);
  let result: CleanupHistoryEntry["result"] = "skipped";
  let message = "Cleanup skipped.";
  let reclaimedBytes = record.public.estimatedReclaimBytes;

  if (options.action.type === "stop_stale_app_server") {
    if (record.pid === undefined) throw new ActivityConflictError("missing process target");
    try {
      killProcess(record.pid, 0);
      killProcess(record.pid, "SIGTERM");
      result = "completed";
      message = "Cleanup completed.";
    } catch (err) {
      if (isNoSuchProcess(err)) {
        result = "already_clean";
        message = "The target was already clean.";
        reclaimedBytes = undefined;
      } else if (isPermissionDenied(err)) {
        result = "failed";
        message = "Cleanup failed.";
        reclaimedBytes = undefined;
      } else {
        throw err;
      }
    }
  }

  const history = await options.history.append({
    actor: options.action.mode === "automatic" ? "auto_policy" : "owner",
    actionType: options.action.type,
    targetLabel: record.public.targetLabel,
    result,
    reclaimedBytes,
    reasonCode: record.reasonCode,
  });

  return {
    actionId: `act_${history.id.replace(/^hist_/, "")}`,
    result,
    reclaimedBytes,
    message,
    snapshotRefreshRecommended: true,
  };
}

function isAutomaticType(type: CleanupAction["type"]): boolean {
  return type === "stop_stale_app_server" || type === "clean_cache_scope" || type === "prune_old_bundle";
}

function sanitizeLabel(value: string): string {
  return value.replace(/[^\w .:@/-]/g, "").slice(0, 80) || "cleanup target";
}

function isNoSuchProcess(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "ESRCH";
}

function isPermissionDenied(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "EPERM";
}
