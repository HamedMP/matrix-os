export type CleanupActionType =
  | "stop_stale_app_server"
  | "close_stale_terminal_session"
  | "restart_idle_code_server"
  | "clean_cache_scope"
  | "prune_old_bundle";

export type CleanupConfidence = "high" | "medium" | "manual_review";
export type CleanupRisk = "low" | "medium" | "high";

export interface MachineIdentity {
  handle: string | null;
  runtimeSlot: string;
  hostname: string;
  status: "healthy" | "degraded" | "unknown";
  releaseVersion?: string;
  releaseChannel?: string;
  gitCommit?: string;
  uptimeSeconds: number;
}

export interface ResourceSummary {
  cpu: {
    cores: number;
    load1: number;
    load5: number;
    load15: number;
    pressureSome10?: number;
  };
  memory: {
    totalBytes: number;
    usedBytes: number;
    availableBytes: number;
    processRssBytes: number;
    cgroupAnonBytes?: number;
    cgroupFileBytes?: number;
    cgroupKernelBytes?: number;
  };
  swap: {
    totalBytes: number;
    usedBytes: number;
  };
  disk: Array<{
    mount: string;
    label: string;
    usedBytes: number;
    totalBytes: number;
    usedPercent: number;
  }>;
}

export interface ServiceStatus {
  serviceId: string;
  state: "running" | "starting" | "stopped" | "failed" | "unknown";
  memoryBytes?: number;
  cpuSeconds?: number;
  tasks?: number;
  restartCount?: number;
}

export interface ProcessSummary {
  processRef: string;
  pid?: number;
  ownerClass: "matrix" | "root" | "system" | "unknown";
  classification:
    | "matrix_service"
    | "app_server"
    | "terminal_session"
    | "code_editor"
    | "database"
    | "system"
    | "unknown";
  displayName: string;
  cpuPercent: number;
  rssBytes: number;
  elapsedSeconds: number;
  ports: number[];
  activeConnections?: number;
}

export interface CleanupCandidate {
  candidateId: string;
  type: CleanupActionType;
  targetLabel: string;
  reason: string;
  confidence: CleanupConfidence;
  risk: CleanupRisk;
  estimatedReclaimBytes?: number;
  requiresConfirmation: boolean;
  confirmationToken: string;
  expiresAt: string;
}

export interface ActivitySnapshot {
  generatedAt: string;
  machine: MachineIdentity;
  resources: ResourceSummary;
  services: ServiceStatus[];
  processes: ProcessSummary[];
  cleanupSuggestions: CleanupCandidate[];
  collectionWarnings: string[];
}

export interface CleanupAction {
  type: CleanupActionType;
  candidateId: string;
  confirmationToken: string;
  mode: "manual" | "automatic";
}

export interface CleanupActionResult {
  actionId: string;
  result: "completed" | "already_clean" | "skipped" | "failed";
  reclaimedBytes?: number;
  message: string;
  snapshotRefreshRecommended: boolean;
}

export interface CleanupHistoryEntry {
  id: string;
  createdAt: string;
  actor: "owner" | "auto_policy";
  actionType: CleanupActionType;
  targetLabel: string;
  result: "completed" | "skipped" | "already_clean" | "failed";
  reclaimedBytes?: number;
  reasonCode: string;
}

export interface AutoCleanupPolicy {
  enabled: boolean;
  allowedTypes: CleanupActionType[];
  gracePeriodSeconds: number;
  maxActionsPerHour: number;
  lastUpdatedAt: string;
}

export interface ActivityCollectOptions {
  processLimit: number;
  includeSuggestions: boolean;
}

export class ActivityConflictError extends Error {
  constructor(message = "Cleanup target changed") {
    super(message);
    this.name = "ActivityConflictError";
  }
}

export class ActivityForbiddenError extends Error {
  constructor(message = "Cleanup policy rejected action") {
    super(message);
    this.name = "ActivityForbiddenError";
  }
}
