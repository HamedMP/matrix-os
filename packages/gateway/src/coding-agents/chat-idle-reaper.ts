import { randomUUID } from "node:crypto";
import type { createUserSystemdTerminalRuntime } from "@matrix-os/terminal-runtime/user-systemd-controller";
import { workspaceRuntimeId } from "../user-systemd-zellij-runtime.js";
import type { WorkspaceSessionOrchestrator } from "../workspace-session-orchestrator.js";
import type { CodingAgentThreadStore } from "./thread-store.js";
import type { CodexControlClient } from "./codex-control-client.js";
import type { IdleWorkspaceIdentity } from "./idle-workspace-state.js";

type Report = { checked: number; reclaimed: number; skipped: number };
const IDLE_MS = 5 * 60_000;
const PRESSURE_IDLE_MS = 60_000;
const RETRY_MS = 5 * 60_000;

/** Reconcile durable ownership before stopping any runtime. Unknown/legacy sessions fail closed. */
export function createChatIdleReaper(options: {
  controller: Pick<ReturnType<typeof createUserSystemdTerminalRuntime>, "list" | "isRunning" | "hibernateWorkspace">;
  sessions: Pick<WorkspaceSessionOrchestrator, "getSession">;
  threads: Pick<CodingAgentThreadStore, "withIdleWorkspace">;
  control: Pick<CodexControlClient, "hibernate">;
  admitCanonical: (identity: IdleWorkspaceIdentity, reclaim: () => Promise<boolean>) => Promise<boolean>;
  unwatch: (sessionId: string) => void;
  underPressure: () => Promise<boolean>;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  const retryAfter = new Map<string, number>(); // bounded by descriptor inventory; TTL cleanup on each sweep
  let cursor = 0;
  let closed = false;
  let pending: Promise<Report> | undefined;

  async function reconcile(): Promise<Report> {
    const report = { checked: 0, reclaimed: 0, skipped: 0 };
    if (closed || !options.control.hibernate) return report;
    const time = now();
    for (const [id, expires] of retryAfter) if (expires <= time) retryAfter.delete(id);
    const cutoff = time - (await options.underPressure() ? PRESSURE_IDLE_MS : IDLE_MS);
    const runtimes = await options.controller.list({ scope: "workspace" });
    for (let scanned = 0; scanned < Math.min(runtimes.length, 8) && report.reclaimed < 2 && !closed; scanned++) {
      cursor %= runtimes.length;
      const runtime = runtimes[cursor++];
      if (runtime.scope !== "workspace" || !/^sess_[A-Za-z0-9_-]+$/.test(runtime.displayName)
        || runtime.runtimeId !== workspaceRuntimeId(runtime.displayName) || retryAfter.has(runtime.runtimeId)) continue;
      report.checked++;
      try {
        const reclaimed = await options.threads.withIdleWorkspace(runtime.displayName, cutoff, async (identity) => {
          const ownerSession = await options.sessions.getSession(identity.sessionId);
          if (!ownerSession.ok || ownerSession.session.ownerId !== identity.ownerId
            || ownerSession.session.id !== identity.sessionId || ownerSession.session.kind !== "agent"
            || ownerSession.session.agent !== "codex" || ownerSession.session.attachedClients > 0
            || !(Date.parse(ownerSession.session.lastActivityAt) <= cutoff)
            || !await options.controller.isRunning(runtime.runtimeId)) return false;
          return options.admitCanonical(identity, async () => {
            if (closed) return false;
            // A recorded stop intent survives a gateway crash. Otherwise require the live runner's idle boundary.
            if (!runtime.hibernatedAt) await options.control.hibernate!({ sessionId: identity.sessionId,
              providerThreadId: identity.providerThreadId, clientRequestId: `req_${randomUUID()}` });
            await options.controller.hibernateWorkspace(runtime.runtimeId, runtime);
            options.unwatch(identity.sessionId);
            return true;
          });
        });
        if (reclaimed) report.reclaimed++;
        else report.skipped++;
      } catch (error: unknown) {
        report.skipped++;
        if (retryAfter.size >= 256) retryAfter.delete(retryAfter.keys().next().value!);
        retryAfter.set(runtime.runtimeId, time + RETRY_MS);
        console.warn("[chat-runtime] idle reclamation deferred", { errorType: error instanceof Error ? error.name : "UnknownError" });
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
      console.warn("[chat-runtime] idle reconciliation unavailable", { errorType: error instanceof Error ? error.name : "UnknownError" });
    });
  }, 10_000);
  timer.unref();
  return {
    sweep,
    async close() { closed = true; clearInterval(timer); await pending; retryAfter.clear(); },
  };
}
