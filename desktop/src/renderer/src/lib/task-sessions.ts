// Shared "start a cloud session bound to a task" flow, used by both the task
// workspace launch controls and the board card quick actions. Talks to the
// stores directly so it works from event handlers outside React render.
import type { ApiClient } from "./api";
import { useBoard } from "../stores/board";
import { useSessions } from "../stores/sessions";

export interface StartTaskSessionInput {
  projectSlug: string;
  taskId: string;
  worktreeId: string | null;
  title: string;
  description: string;
  kind: "shell" | "agent";
  agent?: "claude" | "codex";
}

/**
 * Creates a terminal/agent session on the cloud computer scoped to the task
 * (agent prompt prefilled from the task), links it back onto the task, and
 * flips the task to "running". Returns true on success.
 */
export async function startTaskSession(api: ApiClient, input: StartTaskSessionInput): Promise<boolean> {
  const prompt =
    input.kind === "agent"
      ? [input.title, input.description].filter((s) => s.trim().length > 0).join("\n\n")
      : undefined;
  const created = await useSessions.getState().create(api, {
    kind: input.kind,
    ...(input.agent ? { agent: input.agent } : {}),
    projectSlug: input.projectSlug,
    taskId: input.taskId,
    ...(input.worktreeId ? { worktreeId: input.worktreeId } : {}),
    ...(prompt ? { prompt } : {}),
  });
  if (!created) return false;
  await useBoard.getState().linkSession(api, input.projectSlug, input.taskId, {
    linkedSessionId: created.sessionId,
    ...(input.worktreeId ? { linkedWorktreeId: input.worktreeId } : {}),
    status: "running",
  });
  return true;
}
