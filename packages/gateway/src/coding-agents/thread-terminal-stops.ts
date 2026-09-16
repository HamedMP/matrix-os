import { z } from "zod/v4";
import { IsoTimestampSchema, TerminalRefSchema, TerminalSessionIdSchema } from "@matrix-os/contracts";
import type { StoredThread } from "./thread-store.js";

export const MAX_PENDING_TERMINAL_STOPS = 100;
export const TerminalStoppedStatusSchema = z.enum(["exited", "failed", "degraded"]);
const CurrentTerminalStopSchema = z.object({
  ownerId: z.string().min(1).max(160).regex(/^[A-Za-z0-9_.:@-]+$/),
  workspaceSessionId: z.string().min(1).max(160).regex(/^sess_[A-Za-z0-9_-]+$/).optional(),
  terminalRef: TerminalRefSchema,
  runtimeStatus: TerminalStoppedStatusSchema,
  occurredAt: IsoTimestampSchema,
}).strict();
// A legacy session name cannot identify a shared-workspace tab. Preserve these
// records under the existing bounded retention policy, but never match them to
// modern terminals. Accept only the exact historical schema, not arbitrary data.
const LegacyTerminalStopSchema = CurrentTerminalStopSchema.omit({ terminalRef: true }).extend({
  terminalSessionId: TerminalSessionIdSchema,
}).strict();
export const PendingTerminalStopSchema = z.union([CurrentTerminalStopSchema, LegacyTerminalStopSchema]);
export type PendingTerminalStop = z.infer<typeof PendingTerminalStopSchema>;
type CurrentTerminalStop = z.infer<typeof CurrentTerminalStopSchema>;
type TerminalStopKey = Pick<CurrentTerminalStop, "ownerId" | "workspaceSessionId" | "terminalRef"> |
  Pick<z.infer<typeof LegacyTerminalStopSchema>, "ownerId" | "workspaceSessionId" | "terminalSessionId">;

export function appendPendingTerminalStop(
  pendingTerminalStops: PendingTerminalStop[],
  stop: CurrentTerminalStop,
): PendingTerminalStop[] {
  return [
    ...pendingTerminalStops.filter((candidate) =>
      !("terminalRef" in candidate) ||
      candidate.ownerId !== stop.ownerId ||
      candidate.workspaceSessionId !== stop.workspaceSessionId ||
      candidate.terminalRef.workspaceId !== stop.terminalRef.workspaceId ||
      candidate.terminalRef.tabId !== stop.terminalRef.tabId
    ),
    stop,
  ].slice(-MAX_PENDING_TERMINAL_STOPS);
}

function workspaceSessionIdForThread(threadId: string): string {
  return `sess_${threadId.slice("thread_".length)}`;
}

export function terminalStopMatchesThread(stop: TerminalStopKey, thread: Pick<StoredThread, "id" | "ownerId" | "terminalRef">): boolean {
  return "terminalRef" in stop && thread.ownerId === stop.ownerId &&
    thread.terminalRef?.workspaceId === stop.terminalRef.workspaceId &&
    thread.terminalRef.tabId === stop.terminalRef.tabId &&
    (stop.workspaceSessionId === undefined || stop.workspaceSessionId === workspaceSessionIdForThread(thread.id));
}

export function consumePendingTerminalStop(
  pendingTerminalStops: PendingTerminalStop[],
  thread: StoredThread,
): { pendingStop?: PendingTerminalStop; pendingTerminalStops: PendingTerminalStop[] } {
  if (!thread.terminalRef) {
    return { pendingTerminalStops };
  }
  const pendingStop = pendingTerminalStops.find((candidate) => terminalStopMatchesThread(candidate, thread));
  if (!pendingStop) {
    return { pendingTerminalStops };
  }
  return {
    pendingStop,
    pendingTerminalStops: pendingTerminalStops.filter((candidate) => candidate !== pendingStop),
  };
}
