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
        }) ?? run;
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
        }) ?? run;
      }
      const running = await options.repository.updateRun(ownerId, run.id, {
        status: "running",
        worktreeId: worktreeResult.worktree.id,
        worktreePath: worktreeResult.worktree.path,
        sessionId: sessionResult.session.id,
        lastEvent: "Agent session started",
        startedAt: timestamp,
      }) ?? run;
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
      }) ?? run;
    }
  }

  async function pollOnce(ownerId: string): Promise<{ matchedTickets: number; dispatched: number; skipped: number }> {
    const snapshot = await options.repository.getSnapshot(ownerId);
    if (!snapshot.installation || !snapshot.rule || !snapshot.installation.enabled || !snapshot.installation.credentialConfigured) {
      return { matchedTickets: 0, dispatched: 0, skipped: 0 };
    }
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
    const preview = await options.linearSource.previewTickets(snapshot.rule, credential, { limit: 100 });
    const activeRuns = (await options.repository.listRuns(ownerId, { limit: 100 }))
      .filter((run) => run.status === "running");
    const capacity = Math.max(0, (snapshot.installation.maxConcurrentAgents ?? DEFAULT_MAX_CONCURRENT_AGENTS) - activeRuns.length);
    let dispatched = 0;
    for (const ticket of preview.tickets) {
      if (dispatched >= capacity) break;
      if (!shouldDispatch(ticket, snapshot.rule)) continue;
      const existing = await options.repository.findActiveRunByClaim(ownerId, claimKey(ticket));
      if (existing && isRetryBackoffActive(existing)) continue;
      if (existing && existing.status !== "queued" && existing.status !== "retrying") continue;
      const run = await dispatchTicket(ownerId, snapshot.installation, snapshot.rule, ticket, existing);
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
      if (run.sessionId) {
        await options.agentSessionManager.killSession(run.sessionId).catch((err: unknown) => {
          console.warn("[symphony] Run stop session kill failed:", err instanceof Error ? err.message : String(err));
        });
      }
      const updated = await options.repository.updateRun(ownerId, runId, {
        status: "stopped",
        lastEvent: "Run stopped",
        finishedAt: nowIso(),
      });
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
      if (run.sessionId) {
        await options.agentSessionManager.killSession(run.sessionId).catch((err: unknown) => {
          console.warn("[symphony] Retry run session kill failed:", err instanceof Error ? err.message : String(err));
        });
      }
      const updated = await options.repository.updateRun(ownerId, runId, {
        status: "queued",
        attempt: run.attempt + 1,
        lastEvent: "Run queued for retry",
        lastErrorCode: undefined,
        nextRetryAt: undefined,
      });
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
