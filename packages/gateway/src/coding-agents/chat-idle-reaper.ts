import { randomUUID } from "node:crypto";
import type { TerminalRef, TerminalWorkspace } from "@matrix-os/contracts";
import type { TerminalRuntimeSocketClient } from "@matrix-os/terminal-runtime";
import type { WorkspaceSessionOrchestrator } from "../workspace-session-orchestrator.js";
import type { CodingAgentThreadStore } from "./thread-store.js";
import type { CodexControlClient } from "./codex-control-client.js";
import type { IdleWorkspaceIdentity } from "./idle-workspace-state.js";

type Report = { checked: number; reclaimed: number; skipped: number };
type Sessions = Pick<WorkspaceSessionOrchestrator, "getSession" | "listSessions">;
type TerminalRuntime = Pick<TerminalRuntimeSocketClient, "listWorkspaces" | "terminateTab">;
const IDLE_MS = 5 * 60_000;
const PRESSURE_IDLE_MS = 60_000;
const RETRY_MS = 5 * 60_000;
const ACTIVE_TAB_STATUSES = new Set(["starting", "running", "idle"]);

function terminalRefKey(ref: TerminalRef): string {
  return `${ref.workspaceId}:${ref.tabId}`;
}

function activeTerminalRefs(workspaces: TerminalWorkspace[]): Set<string> {
  return new Set(workspaces.flatMap((workspace) => workspace.tabs
    .filter((tab) => ACTIVE_TAB_STATUSES.has(tab.status))
    .map((tab) => terminalRefKey({ workspaceId: workspace.id, tabId: tab.id }))));
}

export async function isWorkspaceSessionRuntimeAlive(
  sessionId: string,
  sessions: Pick<Sessions, "getSession">,
  terminalRuntime: Pick<TerminalRuntime, "listWorkspaces">,
): Promise<boolean> {
  const current = await sessions.getSession(sessionId);
  if (!current.ok) return false;
  return activeTerminalRefs(await terminalRuntime.listWorkspaces())
    .has(terminalRefKey(current.session.terminalRef));
}

/** Reconcile durable ownership before stopping only the idle tab; sibling project tabs remain alive. */
export function createChatIdleReaper(options: {
  sessions: Sessions;
  terminalRuntime: TerminalRuntime;
  threads: Pick<CodingAgentThreadStore, "withIdleWorkspace">;
  control: Pick<CodexControlClient, "hibernate">;
  admitCanonical: (identity: IdleWorkspaceIdentity, reclaim: () => Promise<boolean>) => Promise<boolean>;
  unwatch: (sessionId: string) => void;
  underPressure: () => Promise<boolean>;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  const retryAfter = new Map<string, number>(); // capped below; TTL cleanup on each sweep
  let cursor = 0;
  let closed = false;
  let pending: Promise<Report> | undefined;

  async function reconcile(): Promise<Report> {
    const report = { checked: 0, reclaimed: 0, skipped: 0 };
    if (closed || !options.control.hibernate) return report;
    const time = now();
    for (const [id, expires] of retryAfter) if (expires <= time) retryAfter.delete(id);
    const cutoff = time - (await options.underPressure() ? PRESSURE_IDLE_MS : IDLE_MS);
    const listed = await options.sessions.listSessions({ limit: 100 });
    if (!listed.ok) return report;
    const candidates = listed.sessions.filter((session) => (
      session.kind === "agent"
      && session.agent === "codex"
      && ["starting", "running", "idle", "waiting"].includes(session.runtime.status)
    ));
    if (candidates.length === 0) return report;
    const liveTerminalRefs = activeTerminalRefs(await options.terminalRuntime.listWorkspaces());
    for (let scanned = 0; scanned < Math.min(candidates.length, 8) && report.reclaimed < 2 && !closed; scanned++) {
      cursor %= candidates.length;
      const candidate = candidates[cursor++]!;
      if (retryAfter.has(candidate.id)) continue;
      report.checked++;
      try {
        const reclaimed = await options.threads.withIdleWorkspace(candidate.id, cutoff, async (identity) => {
          const ownerSession = await options.sessions.getSession(identity.sessionId);
          if (!ownerSession.ok || ownerSession.session.ownerId !== identity.ownerId
            || ownerSession.session.id !== identity.sessionId || ownerSession.session.kind !== "agent"
            || ownerSession.session.agent !== "codex" || ownerSession.session.attachedClients > 0
            || !(Date.parse(ownerSession.session.lastActivityAt) <= cutoff)
            || !liveTerminalRefs.has(terminalRefKey(ownerSession.session.terminalRef))) return false;
          return options.admitCanonical(identity, async () => {
            if (closed) return false;
            await options.control.hibernate!({
              sessionId: identity.sessionId,
              providerThreadId: identity.providerThreadId,
              clientRequestId: `req_${randomUUID()}`,
            });
            await options.terminalRuntime.terminateTab(ownerSession.session.terminalRef);
            liveTerminalRefs.delete(terminalRefKey(ownerSession.session.terminalRef));
            options.unwatch(identity.sessionId);
            return true;
          });
        });
        if (reclaimed) report.reclaimed++;
        else report.skipped++;
      } catch (error: unknown) {
        report.skipped++;
        if (retryAfter.size >= 256) retryAfter.delete(retryAfter.keys().next().value!);
        retryAfter.set(candidate.id, time + RETRY_MS);
        console.warn("[chat-runtime] idle reclamation deferred", {
          errorType: error instanceof Error ? error.name : "UnknownError",
        });
      }
    }
    return report;
  }

  function sweep(): Promise<Report> {
    if (pending) return pending;
    pending = reconcile().finally(() => { pending = undefined; });
    return pending;
  }
  const timer = setInterval(() => {
    void sweep().then((report) => {
      if (report.reclaimed) console.info("[chat-runtime] idle reclamation", report);
    }).catch((error: unknown) => {
      console.warn("[chat-runtime] idle reconciliation unavailable", {
        errorType: error instanceof Error ? error.name : "UnknownError",
      });
    });
  }, 10_000);
  timer.unref();
  return {
    sweep,
    async close() {
      closed = true;
      clearInterval(timer);
      await pending;
      retryAfter.clear();
    },
  };
}
