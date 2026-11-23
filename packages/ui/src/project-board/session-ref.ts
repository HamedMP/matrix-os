import { TaskSessionRefSchema } from "@matrix-os/contracts/project-tasks";

export interface TaskTerminalTarget { kind: "terminal"; workspaceId: string; tabId: string }
/** @deprecated name kept for existing imports; sessions are terminals only. */
export type TaskSessionTarget = TaskTerminalTarget;

/**
 * The terminal tab a task session's ref points to (`term.<workspace>.<tab>`).
 * A task's chat is the task itself (`task.chatId`), so chat refs are not sessions.
 */
export function taskSessionTarget(ref: string): TaskTerminalTarget | null {
  if (!TaskSessionRefSchema.safeParse(ref).success || !ref.startsWith("term.")) return null;
  const [, workspaceId, tabId] = ref.split(".");
  return workspaceId && tabId ? { kind: "terminal", workspaceId, tabId } : null;
}
