import type { CanonicalChatSnapshot } from "@matrix-os/contracts";

export type CanonicalChatPhase =
  | "draft"
  | "running"
  | "waiting_for_approval"
  | "waiting_for_input"
  | "ready"
  | "failed"
  | "archived";

export interface CanonicalChatController {
  chatId: string;
  projectId?: string;
  phase: CanonicalChatPhase;
  instanceLocked: boolean;
  canSubmit: boolean;
  canAbort: boolean;
}

export function deriveCanonicalChatController(
  snapshot: CanonicalChatSnapshot,
): CanonicalChatController {
  const activeRun = snapshot.chat.activeRun;
  const lastRun = snapshot.runs.at(-1);
  const archived = snapshot.chat.lifecycle === "archived";
  const phase: CanonicalChatPhase = archived
    ? "archived"
    : activeRun?.status === "waiting_for_approval"
      ? "waiting_for_approval"
      : activeRun?.status === "waiting_for_input"
        ? "waiting_for_input"
        : activeRun
          ? "running"
          : lastRun?.status === "failed"
            ? "failed"
            : snapshot.turns.length === 0
              ? "draft"
              : "ready";

  return {
    chatId: snapshot.chat.id,
    ...(snapshot.chat.project ? { projectId: snapshot.chat.project.projectId } : {}),
    phase,
    instanceLocked: snapshot.chat.providerBinding !== undefined,
    canSubmit: !archived && activeRun === undefined,
    canAbort: activeRun !== undefined,
  };
}
