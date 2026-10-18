/** Durable records live in owner-controlled Postgres; a DO stores only its alarm. */
export type RuntimeState = 'sleeping' | 'queued' | 'starting' | 'ready' | 'running' | 'checkpointing' | 'interrupting' | 'failed';
export type RuntimePlacement = 'pooled' | 'personal';
export interface RuntimeSummary {
  state: RuntimeState;
  placement: RuntimePlacement;
  activeRuns: number;
  generation: number;
  idleSince: number | null;
}
export interface RuntimeJob {
  ownerId: string;
  jobId: string;
  type: 'wake' | 'chat';
  chatId?: string;
  message?: string;
}
export interface RuntimeLease {
  ownerId: string;
  jobId: string;
  generation: number;
  expiresAt: number;
  maxRunAt: number;
}
export interface RuntimeCheckpoint {
  /** Opaque native DirectoryBackupRecord; validated by the SDK on restore. */
  backup: unknown;
  createdAt: number;
  generation: number;
}
export interface RuntimeStore {
  bindRuntime(runtimeId: string, ownerId: string): Promise<void>;
  ownerForRuntime(runtimeId: string): Promise<string | null>;
  status(ownerId: string): Promise<RuntimeSummary>;
  /** Atomic insert/upsert, generation fence, cap and claim. Existing jobs never rerun. */
  claim(job: RuntimeJob, now: number, leaseMs: number, maxRunMs: number): Promise<RuntimeLease | null>;
  /** Fences old generation and quarantines compute until destruction succeeds. */
  beginIdleInterrupt(ownerId: string, generation: number, now: number): Promise<number | null>;
  beginInterrupt(lease: RuntimeLease, now: number): Promise<number | null>;
  heartbeat(lease: RuntimeLease, now: number, leaseMs: number): Promise<boolean>;
  finish(lease: RuntimeLease, outcome: 'completed' | 'interrupted', now: number): Promise<boolean>;
  active(ownerId: string, now: number): Promise<RuntimeLease[]>;
  /** Atomically fence expired leases and mark them interrupted/recoverable. */
  recoverExpired(ownerId: string, now: number): Promise<void>;
  /** Only succeeds after idle grace and with no active jobs; blocks new claims. */
  beginCheckpoint(ownerId: string, now: number, idleGraceMs: number): Promise<number | null>;
  saveCheckpoint(ownerId: string, checkpoint: RuntimeCheckpoint): Promise<boolean>;
  latestCheckpoint(ownerId: string): Promise<RuntimeCheckpoint | null>;
  markSleeping(ownerId: string, generation: number): Promise<boolean>;
  /** Confirmed native destruction is the only interrupted-reservation settlement proof. */
  confirmStopped?(ownerId: string, generation: number, now: number): Promise<boolean>;
  fail(ownerId: string, generation: number): Promise<void>;
}
export interface RuntimeDriver {
  readonly running: boolean;
  start(ownerId: string, checkpoint: RuntimeCheckpoint | null, generation: number): Promise<void>;
  execute(job: RuntimeJob, lease: RuntimeLease): Promise<void>;
  keepAlive(): Promise<void>;
  checkpoint(ownerId: string, generation: number): Promise<RuntimeCheckpoint>;
  stop(): Promise<void>;
  cancel(lease: RuntimeLease): Promise<void>;
}
export interface RuntimePolicy {
  leaseMs: number;
  heartbeatMs: number;
  idleGraceMs: number;
  maxRunMs: number;
}
export const DEFAULT_RUNTIME_POLICY: RuntimePolicy = {
  leaseMs: 120_000, heartbeatMs: 15_000, idleGraceMs: 60_000, maxRunMs: 5 * 60_000,
};

export interface RuntimePolicyEnvironment {
  RUNTIME_HEARTBEAT_MS?: string;
  RUNTIME_LEASE_MS?: string;
  RUNTIME_IDLE_GRACE_MS?: string;
  RUNTIME_MAX_RUN_MS?: string;
}
/** Cold start and model waits outlive UI-friendly heartbeat intervals. */
export function runtimePolicyFromEnvironment(env: RuntimePolicyEnvironment): RuntimePolicy {
  const heartbeatMs = Number(env.RUNTIME_HEARTBEAT_MS ?? DEFAULT_RUNTIME_POLICY.heartbeatMs);
  return {
    heartbeatMs,
    leaseMs: Number(env.RUNTIME_LEASE_MS ?? Math.max(120_000,heartbeatMs * 4)),
    idleGraceMs:Number(env.RUNTIME_IDLE_GRACE_MS ?? DEFAULT_RUNTIME_POLICY.idleGraceMs),
    maxRunMs:Number(env.RUNTIME_MAX_RUN_MS ?? DEFAULT_RUNTIME_POLICY.maxRunMs),
  };
}
