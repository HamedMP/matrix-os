import { BackgroundAgentRefSchema, type BackgroundAgentRef } from "../domains/sessions/background-agent-runtime.js";
import { z } from "zod/v4";
import { TerminalRefSchema, type TerminalRef } from "@matrix-os/contracts";
import { logCodingAgentWarning } from "./diagnostics.js";
import type { CodingAgentThreadStore } from "./thread-store.js";

const DEFAULT_MAX_PENDING_STOPS = 100;
const DEFAULT_RETRY_DELAY_MS = 1_000;
const MAX_RETRY_DELAY_MS = 60_000;
const OwnerIdSchema = z.string().min(1).max(160).regex(/^[A-Za-z0-9_.:@-]+$/);
const WorkspaceSessionIdSchema = z.string().min(1).max(160).regex(/^sess_[A-Za-z0-9_-]+$/);

const SessionStopInputSchema = z.object({
  id: WorkspaceSessionIdSchema,
  kind: z.enum(["shell", "agent"]),
  ownerId: OwnerIdSchema,
  runtime: z.object({
    status: z.enum(["starting", "running", "idle", "waiting", "exited", "failed", "degraded"]),
  }).passthrough(),
  terminalRef: TerminalRefSchema.optional(),
  backgroundRef: BackgroundAgentRefSchema.optional(),
}).passthrough().refine(input => !!input.terminalRef !== !!input.backgroundRef, "Execution identity required");

type SessionStopInput = z.infer<typeof SessionStopInputSchema>;
type PendingStop = {
  ownerId: string;
  workspaceSessionId: string;
  terminalRef?: TerminalRef;
  backgroundRef?: BackgroundAgentRef;
  runtimeStatus: "exited" | "failed" | "degraded";
};

function stoppedRuntimeStatus(status: SessionStopInput["runtime"]["status"]): status is PendingStop["runtimeStatus"] {
  return status === "exited" || status === "failed" || status === "degraded";
}

export function createCodingAgentSessionStopReconciler(options: {
  maxPending?: number;
  retryDelayMs?: number;
} = {}) {
  const maxPending = Math.max(1, Math.min(options.maxPending ?? DEFAULT_MAX_PENDING_STOPS, DEFAULT_MAX_PENDING_STOPS));
  const retryDelayMs = Math.max(10, Math.min(options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS, MAX_RETRY_DELAY_MS));
  let threadStore: Pick<CodingAgentThreadStore, "reconcileTerminalTabStopped"> & Partial<Pick<CodingAgentThreadStore, "reconcileBackgroundSessionStopped">> | undefined;
  let pendingStops: PendingStop[] = [];
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  function enqueue(stop: PendingStop): void {
    pendingStops = [
      ...pendingStops.filter((candidate) =>
        candidate.ownerId !== stop.ownerId ||
        candidate.workspaceSessionId !== stop.workspaceSessionId ||
        candidate.terminalRef?.workspaceId !== stop.terminalRef?.workspaceId ||
        candidate.terminalRef?.tabId !== stop.terminalRef?.tabId ||
        candidate.backgroundRef?.id !== stop.backgroundRef?.id
      ),
      stop,
    ].slice(-maxPending);
  }

  function clearRetry(): void {
    if (!retryTimer) return;
    clearTimeout(retryTimer);
    retryTimer = undefined;
  }

  function scheduleRetry(): void {
    if (disposed || retryTimer || !threadStore || pendingStops.length === 0) return;
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      void drainPendingStops().catch((err: unknown) => {
        logCodingAgentWarning("retained session stop retry failed", err);
        scheduleRetry();
      });
    }, retryDelayMs);
    retryTimer.unref?.();
  }

  async function reconcileOrRetain(stop: PendingStop): Promise<void> {
    const store = threadStore;
    if (!store) {
      enqueue(stop);
      return;
    }
    try {
      if (stop.backgroundRef) {
        if (!store.reconcileBackgroundSessionStopped) throw new Error("Background stop reconciliation unavailable");
        await store.reconcileBackgroundSessionStopped({ ownerId: stop.ownerId, workspaceSessionId: stop.workspaceSessionId, backgroundRef: stop.backgroundRef, runtimeStatus: stop.runtimeStatus });
        return;
      }
      await store.reconcileTerminalTabStopped({
        ownerId: stop.ownerId,
        workspaceSessionId: stop.workspaceSessionId,
        terminalRef: stop.terminalRef!,
        runtimeStatus: stop.runtimeStatus,
      });
    } catch (err: unknown) {
      enqueue(stop);
      scheduleRetry();
      throw err;
    }
  }

  async function drainPendingStops(): Promise<void> {
    if (!threadStore || pendingStops.length === 0) return;
    clearRetry();
    const stopsToFlush = pendingStops;
    pendingStops = [];
    let firstError: unknown;
    for (const stop of stopsToFlush) {
      try {
        await reconcileOrRetain(stop);
      } catch (err: unknown) {
        firstError ??= err;
      }
    }
    if (firstError) {
      scheduleRetry();
      throw firstError;
    }
  }

  return {
    async handleSessionStopped(input: unknown): Promise<void> {
      const parsed = SessionStopInputSchema.parse(input);
      if (parsed.kind !== "agent" || !stoppedRuntimeStatus(parsed.runtime.status)) {
        return;
      }
      let firstError: unknown;
      try {
        await drainPendingStops();
      } catch (err: unknown) {
        firstError = err;
      }
      try {
        await reconcileOrRetain({
          ownerId: parsed.ownerId,
          workspaceSessionId: parsed.id,
          ...(parsed.terminalRef ? { terminalRef: parsed.terminalRef } : { backgroundRef: parsed.backgroundRef }),
          runtimeStatus: parsed.runtime.status,
        });
      } catch (err: unknown) {
        firstError ??= err;
      }
      if (firstError) throw firstError;
    },

    async attachThreadStore(store: Pick<CodingAgentThreadStore, "reconcileTerminalTabStopped"> & Partial<Pick<CodingAgentThreadStore, "reconcileBackgroundSessionStopped">>): Promise<void> {
      threadStore = store;
      await drainPendingStops();
    },

    dispose(): void {
      disposed = true;
      clearRetry();
    },
  };
}
