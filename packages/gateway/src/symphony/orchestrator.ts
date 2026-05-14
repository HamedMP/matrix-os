import { createHash, randomUUID } from "node:crypto";
import type { createAgentSessionManager } from "../agent-session-manager.js";
import type { createWorktreeManager } from "../worktree-manager.js";
import {
  DEFAULT_MAX_CONCURRENT_AGENTS,
  type SymphonyInstallation,
  type SymphonyRun,
  type TicketSourceRule,
  type TrackedTicket,
} from "./contracts.js";
import type { LinearSource } from "./linear-source.js";
import { composeSymphonyPrompt, loadWorkflowContract, SymphonyWorkflowError } from "./prompt.js";
import type { SymphonyRepository } from "./repository.js";
import type { SymphonyCredentialStore } from "./credential-store.js";
import type { SymphonyStatusHub } from "./status-hub.js";

type WorktreeManager = Pick<ReturnType<typeof createWorktreeManager>, "createWorktree">;
type AgentSessionManager = Pick<ReturnType<typeof createAgentSessionManager>, "startSession" | "killSession">;

const RETRYABLE_RUN_STATUSES: SymphonyRun["status"][] = ["queued", "running", "retrying", "blocked", "failed", "stopped"];
const RETRYABLE_RUN_STATUSES_WITHOUT_RUNNING: SymphonyRun["status"][] = RETRYABLE_RUN_STATUSES.filter((status) => status !== "running");

function nowIso(): string {
  return new Date().toISOString();
}

function claimKey(ticket: Pick<TrackedTicket, "externalId">): string {
  return `linear:${ticket.externalId}`;
}

function runIdFor(ownerId: string, ticket: Pick<TrackedTicket, "externalId">): string {
  return `run_${createHash("sha256").update(`${ownerId}:${ticket.externalId}`).digest("hex").slice(0, 16)}`;
}

function branchFor(ticket: TrackedTicket): string {
  return ticket.branchName?.trim() || `symphony/${ticket.identifier.toLowerCase().replace(/[^a-z0-9._/-]+/g, "-")}`;
}

function shouldDispatch(ticket: TrackedTicket, rule: TicketSourceRule): boolean {
  if (!rule.activeStates.map((state) => state.toLowerCase()).includes(ticket.stateName.toLowerCase())) return false;
  if (rule.terminalStates.map((state) => state.toLowerCase()).includes(ticket.stateName.toLowerCase())) return false;
  if (rule.assigneeIds.length > 0 && (!ticket.assigneeId || !rule.assigneeIds.includes(ticket.assigneeId))) return false;
  return true;
}

function isRetryBackoffActive(run: SymphonyRun, nowMs = Date.now()): boolean {
  if (run.status !== "retrying" || !run.nextRetryAt) return false;
  const retryAt = Date.parse(run.nextRetryAt);
  return Number.isFinite(retryAt) && retryAt > nowMs;
}

function failedKillCode(result: unknown): string | null {
  if (!result || typeof result !== "object" || !("ok" in result) || (result as { ok?: unknown }).ok !== false) {
    return null;
  }
  const error = (result as { error?: { code?: unknown } }).error;
  return typeof error?.code === "string" ? error.code : "session_kill_failed";
}

export function createMatrixSymphonyOrchestrator(options: {
  homePath: string;
  repository: SymphonyRepository;
  credentialStore: SymphonyCredentialStore;
  linearSource: LinearSource;
  worktreeManager: WorktreeManager;
  agentSessionManager: AgentSessionManager;
  statusHub?: SymphonyStatusHub;
}) {
  const pollTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const pollLocks = new Map<string, Promise<{ matchedTickets: number; dispatched: number; skipped: number }>>();

  async function append(ownerId: string, event: Parameters<SymphonyRepository["appendEvent"]>[1]) {
    const record = await options.repository.appendEvent(ownerId, event);
    await options.statusHub?.publishOperatorEvent(ownerId, record);
    return record;
  }

  async function killRunSession(run: SymphonyRun, logContext: string): Promise<string | null> {
    if (!run.sessionId) return null;
    try {
      return failedKillCode(await options.agentSessionManager.killSession(run.sessionId));
    } catch (err: unknown) {
      console.warn(`[symphony] ${logContext}:`, err instanceof Error ? err.message : String(err));
      return "session_kill_failed";
    }
  }

  async function markRunBlockedAfterKillFailure(ownerId: string, run: SymphonyRun, code: string, actorId?: string): Promise<SymphonyRun | null> {
    const updated = await options.repository.updateRun(ownerId, run.id, {
      status: "blocked",
      lastErrorCode: code,
      lastEvent: "Session could not be stopped",
    }, { allowedStatuses: ["queued", "running", "retrying", "blocked"] });
    await append(ownerId, {
      installationId: run.installationId,
      runId: run.id,
      type: "symphony.run.updated",
      message: "Session could not be stopped",
      severity: "warning",
      actorId,
    });
    return updated;
  }

  async function reconcileIneligibleRunningRuns(
    ownerId: string,
    installation: SymphonyInstallation,
    activeRuns: SymphonyRun[],
    eligibleClaimKeys: Set<string>,
  ): Promise<void> {
    for (const run of activeRuns) {
      if (eligibleClaimKeys.has(run.claimKey)) continue;
      const killFailureCode = await killRunSession(run, "Ineligible run session kill failed");
      if (killFailureCode) {
        await markRunBlockedAfterKillFailure(ownerId, run, killFailureCode);
        continue;
      }
      const stopped = await options.repository.updateRun(ownerId, run.id, {
        status: "stopped",
        lastEvent: "Ticket no longer matches Symphony rule",
        finishedAt: nowIso(),
      }, { allowedStatuses: ["running"] });
      if (!stopped) continue;
      await append(ownerId, {
        installationId: installation.id,
        runId: run.id,
        type: "symphony.run.stopped",
        message: "Ticket no longer matches Symphony rule",
        severity: "info",
      });
    }
  }

  async function dispatchTicket(
    ownerId: string,
    installation: SymphonyInstallation,
    rule: TicketSourceRule,
    ticket: TrackedTicket,
    existing?: SymphonyRun | null,
  ): Promise<SymphonyRun> {
    const active = existing === undefined
      ? await options.repository.findActiveRunByClaim(ownerId, claimKey(ticket))
      : existing;
    const timestamp = nowIso();
    if (active && isRetryBackoffActive(active)) return active;
    if (active && active.status !== "queued" && active.status !== "retrying") return active;

    const run: SymphonyRun = active ?? {
      id: runIdFor(ownerId, ticket),
      installationId: installation.id,
      ticketExternalId: ticket.externalId,
      ticketIdentifier: ticket.identifier,
      ticketTitle: ticket.title,
      ticketUrl: ticket.url,
      status: "queued",
      attempt: 1,
      agent: installation.defaultAgent,
      projectSlug: installation.projectSlug,
      claimKey: claimKey(ticket),
      lastEvent: "Queued for Matrix agent dispatch",
      updatedAt: timestamp,
    };
    if (!active) await options.repository.upsertRun(ownerId, run);
    try {
      const workflow = await loadWorkflowContract({ homePath: options.homePath, projectSlug: installation.projectSlug });
      const worktreeResult = await options.worktreeManager.createWorktree({
        projectSlug: installation.projectSlug,
        branch: branchFor(ticket),
      });
      if (!worktreeResult.ok) {
        return await options.repository.updateRun(ownerId, run.id, {
          status: "retrying",
          lastErrorCode: worktreeResult.error.code,
          lastEvent: "Worktree could not be created",
          nextRetryAt: new Date(Date.now() + 60_000).toISOString(),
        }, { allowedStatuses: ["queued", "retrying"] }) ?? run;
      }
      const prompt = composeSymphonyPrompt({ workflow, ticket, attempt: run.attempt });
      const sessionResult = await options.agentSessionManager.startSession({
        sessionId: `sess_${run.id}`,
        kind: "agent",
        agent: installation.defaultAgent,
        ownerId,
        projectSlug: installation.projectSlug,
        worktreeId: worktreeResult.worktree.id,
        prompt,
        sandbox: { enabled: true },
      });
      if (!sessionResult.ok) {
        return await options.repository.updateRun(ownerId, run.id, {
          status: "retrying",
          worktreeId: worktreeResult.worktree.id,
          worktreePath: worktreeResult.worktree.path,
          lastErrorCode: sessionResult.error.code,
          lastEvent: "Agent session could not be started",
          nextRetryAt: new Date(Date.now() + 60_000).toISOString(),
        }, { allowedStatuses: ["queued", "retrying"] }) ?? run;
      }
      const running = await options.repository.updateRun(ownerId, run.id, {
        status: "running",
        worktreeId: worktreeResult.worktree.id,
        worktreePath: worktreeResult.worktree.path,
        sessionId: sessionResult.session.id,
        lastEvent: "Agent session started",
        startedAt: timestamp,
      }, { allowedStatuses: ["queued", "retrying"] });
      if (!running) {
        let cleanupFailureCode: string | null = null;
        try {
          cleanupFailureCode = failedKillCode(await options.agentSessionManager.killSession(sessionResult.session.id));
        } catch (err: unknown) {
          console.warn("[symphony] Stale start session cleanup failed:", err instanceof Error ? err.message : String(err));
          cleanupFailureCode = "session_kill_failed";
        }
        if (cleanupFailureCode) {
          const blocked = await options.repository.updateRun(ownerId, run.id, {
            status: "blocked",
            sessionId: sessionResult.session.id,
            worktreeId: worktreeResult.worktree.id,
            worktreePath: worktreeResult.worktree.path,
            lastErrorCode: cleanupFailureCode,
            lastEvent: "Stale agent session could not be stopped",
          }, { allowedStatuses: ["queued", "running", "retrying", "blocked", "stopped", "failed"] });
          if (blocked) {
            await append(ownerId, {
              installationId: installation.id,
              runId: run.id,
              type: "symphony.run.updated",
              message: "Stale agent session could not be stopped",
              severity: "warning",
            });
            return blocked;
          }
        }
        return await options.repository.getRun(ownerId, run.id) ?? run;
      }
      await append(ownerId, {
        installationId: installation.id,
        runId: running.id,
        type: "symphony.run.updated",
        message: "Agent session started",
        severity: "info",
      });
      return running;
    } catch (err: unknown) {
      const code = err instanceof SymphonyWorkflowError ? err.code : "dispatch_failed";
      console.warn("[symphony] Dispatch failed:", err instanceof Error ? err.message : String(err));
      return await options.repository.updateRun(ownerId, run.id, {
        status: "blocked",
        lastErrorCode: code,
        lastEvent: "Symphony dispatch needs attention",
      }, { allowedStatuses: ["queued", "retrying"] }) ?? await options.repository.getRun(ownerId, run.id) ?? run;
    }
  }

  async function pollOnce(ownerId: string): Promise<{ matchedTickets: number; dispatched: number; skipped: number }> {
    const snapshot = await options.repository.getSnapshot(ownerId);
    if (!snapshot.installation || !snapshot.rule || !snapshot.installation.enabled || !snapshot.installation.credentialConfigured) {
      return { matchedTickets: 0, dispatched: 0, skipped: 0 };
    }
    const installation = snapshot.installation;
    const rule = snapshot.rule;
    const credential = await options.credentialStore.readLinearCredential(ownerId);
    if (!credential) {
      await append(ownerId, {
        installationId: snapshot.installation.id,
        type: "symphony.credential.missing",
        message: "Linear credential is missing",
        severity: "warning",
      });
      return { matchedTickets: 0, dispatched: 0, skipped: 0 };
    }
    const preview = await options.linearSource.previewTickets(rule, credential, { limit: 100 });
    const latestSnapshot = await options.repository.getSnapshot(ownerId);
    if (!latestSnapshot.installation?.enabled) {
      return { matchedTickets: preview.tickets.length, dispatched: 0, skipped: preview.tickets.length };
    }
    if (latestSnapshot.installation.updatedAt !== installation.updatedAt || latestSnapshot.rule?.updatedAt !== rule.updatedAt) {
      return { matchedTickets: preview.tickets.length, dispatched: 0, skipped: preview.tickets.length };
    }
    const [activeRuns, blockedRuns] = await Promise.all([
      options.repository.listRuns(ownerId, { status: "running", limit: 100 }),
      options.repository.listRuns(ownerId, { status: "blocked", limit: 100 }),
    ]);
    const blockedLiveRuns = blockedRuns.filter((run) => Boolean(run.sessionId));
    const eligibleTickets = preview.tickets.filter((ticket) => shouldDispatch(ticket, rule));
    const eligibleClaimKeys = new Set(eligibleTickets.map((ticket) => claimKey(ticket)));
    if (!preview.truncated) await reconcileIneligibleRunningRuns(ownerId, installation, activeRuns, eligibleClaimKeys);
    const countedRunning = preview.truncated
      ? activeRuns.length
      : activeRuns.filter((run) => eligibleClaimKeys.has(run.claimKey)).length;
    const capacity = Math.max(0, (snapshot.installation.maxConcurrentAgents ?? DEFAULT_MAX_CONCURRENT_AGENTS) - countedRunning - blockedLiveRuns.length);
    let dispatched = 0;
    for (const ticket of preview.tickets) {
      if (dispatched >= capacity) break;
      if (!shouldDispatch(ticket, rule)) continue;
      const existing = await options.repository.findActiveRunByClaim(ownerId, claimKey(ticket));
      if (existing && isRetryBackoffActive(existing)) continue;
      if (existing && existing.status !== "queued" && existing.status !== "retrying") continue;
      const run = await dispatchTicket(ownerId, installation, rule, ticket, existing);
      if (run.status === "running" || run.status === "queued" || run.status === "retrying") dispatched += 1;
    }
    const at = nowIso();
    await options.repository.recordPoll(ownerId, at);
    await append(ownerId, {
      installationId: snapshot.installation.id,
      type: "symphony.poll.completed",
      message: "Symphony poll completed",
      severity: "info",
      metadata: { matchedTickets: preview.tickets.length, dispatched, skipped: Math.max(0, preview.tickets.length - dispatched) },
    });
    return { matchedTickets: preview.tickets.length, dispatched, skipped: Math.max(0, preview.tickets.length - dispatched) };
  }

  async function poll(ownerId: string): Promise<{ matchedTickets: number; dispatched: number; skipped: number }> {
    const active = pollLocks.get(ownerId);
    if (active) return active;
    const next = pollOnce(ownerId).finally(() => {
      if (pollLocks.get(ownerId) === next) pollLocks.delete(ownerId);
    });
    pollLocks.set(ownerId, next);
    return next;
  }

  function clearPoll(ownerId: string): void {
    const timer = pollTimers.get(ownerId);
    if (timer) clearTimeout(timer);
    pollTimers.delete(ownerId);
  }

  function schedulePoll(ownerId: string, pollIntervalMs: number): void {
    clearPoll(ownerId);
    const timer = setTimeout(() => {
      pollTimers.delete(ownerId);
      void poll(ownerId)
        .then(async () => {
          const snapshot = await options.repository.getSnapshot(ownerId);
          if (snapshot.installation?.enabled) schedulePoll(ownerId, snapshot.installation.pollIntervalMs);
        })
        .catch((err: unknown) => {
          console.warn("[symphony] Scheduled poll failed:", err instanceof Error ? err.message : String(err));
          void options.repository.getSnapshot(ownerId)
            .then((snapshot) => {
              if (snapshot.installation?.enabled) schedulePoll(ownerId, snapshot.installation.pollIntervalMs);
            })
            .catch((snapshotErr: unknown) => {
              console.warn("[symphony] Poll reschedule check failed:", snapshotErr instanceof Error ? snapshotErr.message : String(snapshotErr));
            });
        });
    }, pollIntervalMs);
    pollTimers.set(ownerId, timer);
  }

  function ensurePolling(ownerId: string, pollIntervalMs: number): void {
    if (!pollTimers.has(ownerId)) schedulePoll(ownerId, pollIntervalMs);
  }

  return {
    async start(ownerId: string, actorId: string) {
      const installation = await options.repository.setEnabled(ownerId, true, actorId);
      ensurePolling(ownerId, installation.pollIntervalMs);
      return installation;
    },

    async stop(ownerId: string, actorId: string) {
      clearPoll(ownerId);
      return options.repository.setEnabled(ownerId, false, actorId);
    },

    async poll(ownerId: string) {
      return poll(ownerId);
    },

    async stopRun(ownerId: string, runId: string, actorId: string) {
      const run = await options.repository.getRun(ownerId, runId);
      if (!run) return null;
      const killFailureCode = await killRunSession(run, "Run stop session kill failed");
      if (killFailureCode) return markRunBlockedAfterKillFailure(ownerId, run, killFailureCode, actorId);
      const updated = await options.repository.updateRun(ownerId, runId, {
        status: "stopped",
        sessionId: undefined,
        worktreeId: undefined,
        worktreePath: undefined,
        lastEvent: "Run stopped",
        finishedAt: nowIso(),
      }, { allowedStatuses: ["queued", "running", "retrying", "blocked"] });
      if (!updated) return await options.repository.getRun(ownerId, runId);
      await append(ownerId, {
        installationId: run.installationId,
        runId,
        type: "symphony.run.stopped",
        message: "Run stopped",
        severity: "info",
        actorId,
      });
      return updated;
    },

    async retryRun(ownerId: string, runId: string, actorId: string) {
      const run = await options.repository.getRun(ownerId, runId);
      if (!run) return null;
      if (!RETRYABLE_RUN_STATUSES.includes(run.status)) return run;
      const killFailureCode = await killRunSession(run, "Retry run session kill failed");
      if (killFailureCode) return markRunBlockedAfterKillFailure(ownerId, run, killFailureCode, actorId);
      const updated = await options.repository.updateRun(ownerId, runId, {
        status: "queued",
        sessionId: undefined,
        worktreeId: undefined,
        worktreePath: undefined,
        attempt: run.attempt + 1,
        lastEvent: "Run queued for retry",
        lastErrorCode: undefined,
        nextRetryAt: undefined,
      }, { allowedStatuses: run.sessionId ? RETRYABLE_RUN_STATUSES : RETRYABLE_RUN_STATUSES_WITHOUT_RUNNING });
      if (!updated) return await options.repository.getRun(ownerId, runId);
      await append(ownerId, {
        installationId: run.installationId,
        runId,
        type: "symphony.run.retry",
        message: "Run queued for retry",
        severity: "info",
        actorId,
      });
      return updated;
    },

    async shutdown() {
      for (const ownerId of Array.from(pollTimers.keys())) clearPoll(ownerId);
      await options.statusHub?.close();
    },

    async resumeEnabledInstallations() {
      const ownerIds = await options.repository.listEnabledOwnerIds();
      for (const ownerId of ownerIds) {
        const snapshot = await options.repository.getSnapshot(ownerId);
        if (snapshot.installation?.enabled) ensurePolling(ownerId, snapshot.installation.pollIntervalMs);
      }
      return ownerIds;
    },

    idForNewRun: () => `run_${randomUUID()}`,
  };
}

export type MatrixSymphonyOrchestrator = ReturnType<typeof createMatrixSymphonyOrchestrator>;
