import { TaskSessionRefSchema } from "@matrix-os/contracts/project-tasks";

export type TaskSessionTarget =
  | { kind: "chat"; chatId: string }
  | { kind: "terminal"; workspaceId: string; tabId: string };

/** Where a task session's ref points: a chat id (`chat_<id>`) or a terminal tab (`term.<workspace>.<tab>`). */
export function taskSessionTarget(ref: string): TaskSessionTarget | null {
  if (!TaskSessionRefSchema.safeParse(ref).success) return null;
  if (ref.startsWith("chat_")) return { kind: "chat", chatId: ref };
  const [, workspaceId, tabId] = ref.split(".");
  return workspaceId && tabId ? { kind: "terminal", workspaceId, tabId } : null;
}
