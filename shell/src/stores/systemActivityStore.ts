import { create } from "zustand";
import { getGatewayUrl } from "@/lib/gateway";

const GATEWAY_URL = getGatewayUrl();
const FETCH_TIMEOUT_MS = 10_000;
const SAFE_ERROR = "Activity data is unavailable.";

export type CleanupActionType =
  | "stop_stale_app_server"
  | "close_stale_terminal_session"
  | "restart_idle_code_server"
  | "clean_cache_scope"
  | "prune_old_bundle";

export interface ActivitySnapshot {
  generatedAt: string;
  machine: {
    handle: string | null;
    runtimeSlot: string;
    hostname: string;
    status: "healthy" | "degraded" | "unknown";
    releaseVersion?: string;
    releaseChannel?: string;
    gitCommit?: string;
    uptimeSeconds: number;
  };
  resources: {
    cpu: { cores: number; load1: number; load5: number; load15: number; pressureSome10?: number };
    memory: {
      totalBytes: number;
      usedBytes: number;
      availableBytes: number;
      processRssBytes: number;
      cgroupAnonBytes?: number;
      cgroupFileBytes?: number;
      cgroupKernelBytes?: number;
    };
    swap: { totalBytes: number; usedBytes: number };
    disk: Array<{ mount: string; label: string; usedBytes: number; totalBytes: number; usedPercent: number }>;
  };
  services: Array<{
    serviceId: string;
    state: "running" | "starting" | "stopped" | "failed" | "unknown";
    memoryBytes?: number;
    cpuSeconds?: number;
    tasks?: number;
    restartCount?: number;
  }>;
  processes: Array<{
    processRef: string;
    pid?: number;
    ownerClass: "matrix" | "root" | "system" | "unknown";
    classification: string;
    displayName: string;
    cpuPercent: number;
    rssBytes: number;
    elapsedSeconds: number;
    ports: number[];
    activeConnections?: number;
  }>;
  cleanupSuggestions: Array<{
    candidateId: string;
    type: CleanupActionType;
    targetLabel: string;
    reason: string;
    confidence: "high" | "medium" | "manual_review";
    risk: "low" | "medium" | "high";
    estimatedReclaimBytes?: number;
    requiresConfirmation: boolean;
    confirmationToken: string;
    expiresAt: string;
  }>;
  collectionWarnings: string[];
}

interface ActivityState {
  snapshot: ActivitySnapshot | null;
  refreshStatus: "idle" | "loading" | "success" | "error";
  cleanupStatus: "idle" | "running" | "success" | "error";
  error: string | null;
  cleanupMessage: string | null;
  refresh: () => Promise<void>;
  runCleanup: (candidateId: string) => Promise<void>;
}

export const useSystemActivityStore = create<ActivityState>()((set, get) => ({
  snapshot: null,
  refreshStatus: "idle",
  cleanupStatus: "idle",
  error: null,
  cleanupMessage: null,
  async refresh() {
    set({ refreshStatus: "loading", error: null });
    try {
      const res = await fetch(`${GATEWAY_URL}/api/system/activity?processLimit=25&includeSuggestions=true`, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error("activity_fetch_failed");
      const snapshot = await res.json() as ActivitySnapshot;
      set({ snapshot, refreshStatus: "success", error: null });
    } catch (err) {
      console.warn("[system-activity] refresh failed:", err instanceof Error ? err.message : String(err));
      set({ refreshStatus: "error", error: SAFE_ERROR });
    }
  },
  async runCleanup(candidateId) {
    if (get().cleanupStatus === "running") return;
    const candidate = get().snapshot?.cleanupSuggestions.find((item) => item.candidateId === candidateId);
    if (!candidate) return;
    set({ cleanupStatus: "running", cleanupMessage: null, error: null });
    try {
      const res = await fetch(`${GATEWAY_URL}/api/system/activity/actions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        body: JSON.stringify({
          type: candidate.type,
          candidateId: candidate.candidateId,
          confirmationToken: candidate.confirmationToken,
          mode: "manual",
        }),
      });
      if (!res.ok) throw new Error("activity_cleanup_failed");
      const result = await res.json() as { message?: string };
      set({ cleanupStatus: "success", cleanupMessage: safeShortMessage(result.message) });
      await get().refresh();
    } catch (err) {
      console.warn("[system-activity] cleanup failed:", err instanceof Error ? err.message : String(err));
      set({ cleanupStatus: "error", cleanupMessage: "Cleanup could not be completed." });
    }
  },
}));

function safeShortMessage(value: unknown): string {
  return typeof value === "string" && value.length > 0 && value.length <= 80
    ? value
    : "Cleanup completed.";
}
