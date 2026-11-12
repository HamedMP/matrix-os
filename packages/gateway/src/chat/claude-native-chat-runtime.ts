import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { boundedOperation } from "../bounded-operation.js";
import { createClaudeChatProviderAdapter } from "./claude-provider-adapter.js";
import { createClaudeNativeSessionPool } from "./claude-native-session.js";
import type {
  ClaudeNativeRecoveryInput, ClaudeNativeRecoveryReceipt, createClaudeNativeRecoveryStore,
} from "./claude-native-recovery-store.js";
import type { ClaudeNativeScheduleJob } from "./claude-native-session-jobs.js";
import type { CanonicalCliProcess } from "./cli-process.js";
import type { NativeScheduledPhaseRequest } from "./native-scheduled-admission.js";

type NativeScheduledAdmitter = { admitNativeScheduledPhase(request: NativeScheduledPhaseRequest): Promise<void> };
type RecoveryStore = Pick<ReturnType<typeof createClaudeNativeRecoveryStore>, "listRecoverable" | "claim" | "saveActive" | "release">;

export interface ClaudeNativeRecoveryHost {
  /** Prove the protected transcript and live source, then supply an idle launch with no inherited Run grants. */
  prepare(receipt: ClaudeNativeRecoveryReceipt, signal: AbortSignal): Promise<{
    sourceFingerprint: string;
    launchProtected(): CanonicalCliProcess;
  } | null>;
  /** Recheck current account, root, model, permission and session isolation before canonical admission. */
  revalidate(checkpoint: ClaudeNativeRecoveryInput, signal: AbortSignal): Promise<boolean>;
  /** Prove the complete protected transcript is available for resume after physical child close. */
  checkpointAfterClose(checkpoint: ClaudeNativeRecoveryInput, signal: AbortSignal): Promise<boolean>;
}

export interface ClaudeNativeRecoveryOptions { ownerId: string; store: RecoveryStore; host: ClaudeNativeRecoveryHost }
const hostSignal = (shutdown: AbortSignal) => AbortSignal.any([shutdown, AbortSignal.timeout(10_000)]);
const STARTUP_DRAIN_MS = 15_000;
const unavailable = () => new Error("Native scheduled Chat unavailable");
const sameScope = (a: ClaudeNativeRecoveryInput, b: ClaudeNativeRecoveryInput) =>
  a.ownerId === b.ownerId && a.chatId === b.chatId && a.sessionId === b.sessionId
    && a.sourceFingerprint === b.sourceFingerprint && a.deadlineAt === b.deadlineAt;
const currentCheckpoint = (value: ClaudeNativeRecoveryInput) =>
  Date.parse(value.deadlineAt) > Date.now() && value.jobs.length > 0 && value.jobs.every(job => job.recurring);
function recoveryCheckpoint({ ownerId, chatId, sessionId, sourceRunId, sourceFingerprint, deadlineAt, jobs }: ClaudeNativeRecoveryInput) {
  return { ownerId, chatId, sessionId, sourceRunId, sourceFingerprint, deadlineAt, jobs };
}

/** Private gateway composition; no public native scheduling or authority endpoint. */
export function createGatewayClaudeChatRuntime(options: Omit<Parameters<typeof createClaudeChatProviderAdapter>[0], "nativeSessions">) {
  // Qualified for exact 2.1.317 by the pool's native version and initial-hook ACK gate.
  // The host-local phase registrar never repeats native initialize on a held prompt.
  const sessions = createClaudeNativeSessionPool({ protocolQualified: true });
  const adapter = createClaudeChatProviderAdapter({ ...options, nativeSessions: sessions });
  const shutdown = new AbortController();
  // Only startup claims are recorded here. The store lists at most 32 receipts for this owner.
  const active = new Map<string, ClaudeNativeRecoveryReceipt>();
  let current: (() => NativeScheduledAdmitter | null) | undefined;
  let recovery: ClaudeNativeRecoveryOptions | undefined, starting: Promise<void> | undefined, closing: Promise<void> | undefined;

  async function admit(request: NativeScheduledPhaseRequest) {
    const orchestrator = current?.();
    if (shutdown.signal.aborted || !orchestrator) throw unavailable();
    await orchestrator.admitNativeScheduledPhase(request);
  }

  async function admitRecovered(
    config: ClaudeNativeRecoveryOptions, claimed: ClaudeNativeRecoveryReceipt, request: NativeScheduledPhaseRequest,
    job: ClaudeNativeScheduleJob, checkpoint?: ClaudeNativeRecoveryInput,
  ) {
    const receipt = active.get(claimed.chatId);
    if (shutdown.signal.aborted || !receipt || !checkpoint || !sameScope(claimed, receipt) || !sameScope(receipt, checkpoint)
      || !currentCheckpoint(checkpoint) || request.owner.type !== "personal" || request.owner.ownerId !== receipt.ownerId
      || request.chatId !== receipt.chatId || request.sessionId !== receipt.sessionId || request.sourceRunId !== checkpoint.sourceRunId
      || !job.recurring || createHash("sha256").update(request.prompt).digest("hex") !== job.promptSha256
      || !checkpoint.jobs.some(item => item.id === job.id && item.promptSha256 === job.promptSha256
        && item.cron === job.cron && item.recurring === job.recurring)) throw unavailable();
    const signal = hostSignal(shutdown.signal);
    if (!await config.host.revalidate(checkpoint, signal) || signal.aborted) throw unavailable();
    const saved = await saveCheckpoint(config.store, checkpoint, receipt);
    if (!saved) throw unavailable();
    active.set(receipt.chatId, saved);
    await admit({ ...request, recovery: {
      ownerId: saved.ownerId, chatId: saved.chatId, sourceRunId: saved.sourceRunId, sessionId: saved.sessionId,
      sourceFingerprint: saved.sourceFingerprint, generation: saved.generation, jobId: job.id, promptSha256: job.promptSha256,
    } });
  }

  async function saveCheckpoint(store: RecoveryStore, checkpoint: ClaudeNativeRecoveryInput, prior?: ClaudeNativeRecoveryReceipt) {
    if (prior && isDeepStrictEqual(recoveryCheckpoint(prior), checkpoint)) return prior;
    return store.saveActive(checkpoint, prior?.generation);
  }

  async function restore(config: ClaudeNativeRecoveryOptions, released: ClaudeNativeRecoveryReceipt) {
    if (released.ownerId !== config.ownerId || released.status !== "released" || !currentCheckpoint(released)) return;
    const claimed = await config.store.claim(released);
    if (!claimed || claimed.status !== "active" || claimed.generation !== released.generation + 1
      || !isDeepStrictEqual(recoveryCheckpoint(claimed), recoveryCheckpoint(released))) return;
    let launchAttempted = false, restored = false;
    try {
      const signal = hostSignal(shutdown.signal);
      if (signal.aborted) return;
      const protectedChild = await config.host.prepare(claimed, signal);
      if (!protectedChild || protectedChild.sourceFingerprint !== claimed.sourceFingerprint || signal.aborted) return;
      active.set(claimed.chatId, claimed);
      await sessions.restoreIdle({
        input: { owner: { type: "personal", ownerId: claimed.ownerId }, chatId: claimed.chatId,
          runId: claimed.sourceRunId, interactionMode: "default" },
        sourceFingerprint: claimed.sourceFingerprint,
        sessionId: claimed.sessionId,
        deadlineMs: Date.parse(claimed.deadlineAt),
        jobs: claimed.jobs.map(({ id, cron, promptSha256, recurring }) => ({ id, cron, promptSha256, recurring })),
        evidence: claimed.jobs,
        launchProtected: () => {
          if (signal.aborted) throw unavailable();
          launchAttempted = true;
          return protectedChild.launchProtected();
        },
        admitRecoveredPhase: (request, job, checkpoint) => admitRecovered(config, claimed, request, job, checkpoint),
      });
      restored = true;
    } finally {
      // A host prepare or pool refusal cannot strand ownership if the protected launcher was never invoked.
      if (!restored && !launchAttempted) {
        if (active.get(claimed.chatId) === claimed) active.delete(claimed.chatId);
        await config.store.release(claimed);
      }
    }
  }

  async function restoreReleased(config: ClaudeNativeRecoveryOptions) {
    const released = await config.store.listRecoverable(config.ownerId);
    for (const receipt of released) {
      if (shutdown.signal.aborted) return;
      try {
        await restore(config, receipt);
      } catch (error: unknown) {
        console.warn("[claude-native] Protected recovery unavailable", typeof error);
      }
    }
  }

  async function releaseAfterClose(checkpoint: ClaudeNativeRecoveryInput) {
    const config = recovery;
    if (!config || checkpoint.ownerId !== config.ownerId || !currentCheckpoint(checkpoint)) return;
    const known = active.get(checkpoint.chatId);
    // Same-session refresh requires its exact claim. A distinct session is checked against the latest source by the store.
    const prior = known?.sessionId === checkpoint.sessionId ? known : undefined;
    if (prior && !sameScope(prior, checkpoint)) return;
    // A job due beyond the original session deadline cannot be recovered. Keep the
    // protected transcript and the persisted job inventory in sync.
    const deadlineMs = Date.parse(checkpoint.deadlineAt);
    const jobs = checkpoint.jobs.filter(({ replay }) => !replay || replay.nextFireAtMs <= deadlineMs);
    if (!jobs.length) return;
    const recoverable = { ...checkpoint, jobs };
    const signal = AbortSignal.timeout(10_000);
    try {
      if (!await config.host.checkpointAfterClose(recoverable, signal) || signal.aborted) return;
      const saved = await saveCheckpoint(config.store, recoverable, prior);
      if (saved) await config.store.release(saved);
    } catch (error: unknown) {
      // Child cleanup remains confirmed. A failed checkpoint or write never releases ownership.
      console.warn("[claude-native] Protected handoff unavailable", typeof error);
    }
  }

  function beginShutdown() {
    shutdown.abort();
  }

  async function closeRecovery(): Promise<void> {
    const startup = starting;
    const drainStartup = startup && boundedOperation(() => startup, STARTUP_DRAIN_MS).catch((error: unknown) => {
      console.warn("[claude-native] Recovery startup drain unavailable", typeof error);
    });
    const [pool] = await Promise.allSettled([
      Promise.resolve().then(() => recovery ? sessions.close(releaseAfterClose) : adapter.closeNativeSessions()),
      drainStartup,
    ]);
    if (pool.status === "rejected") throw pool.reason;
  }

  return {
    adapter,
    bind(resolveCurrent: () => NativeScheduledAdmitter | null) {
      current = resolveCurrent;
      adapter.bindNativeScheduledHandler(admit);
    },
    startRecovery(config: ClaudeNativeRecoveryOptions): Promise<void> {
      if (shutdown.signal.aborted || !current) throw unavailable();
      if (starting) return starting;
      recovery = config;
      starting = restoreReleased(config);
      return starting;
    },
    beginShutdown,
    close(): Promise<void> {
      beginShutdown();
      return closing ??= closeRecovery();
    },
  };
}
