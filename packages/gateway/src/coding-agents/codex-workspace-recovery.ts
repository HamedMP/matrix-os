import type { WorkspaceSessionOrchestrator } from "../workspace-session-orchestrator.js";
import type { CodingAgentProviderAdapter } from "./thread-store.js";

/** Cold resume requires owner-scoped durable identity; never substitute a fresh empty conversation. */
export async function recoverCodexWorkspace(
  runtime: Pick<WorkspaceSessionOrchestrator, "startSession"> & Partial<Pick<WorkspaceSessionOrchestrator, "getSession">>,
  context: Parameters<NonNullable<CodingAgentProviderAdapter["resumeTurn"]>>[0],
  sessionId: string,
  prompt: string,
) {
  const { principal, thread, turn, resumeState, signal } = context;
  signal.throwIfAborted();
  const previous = await runtime.getSession?.(sessionId);
  if (!resumeState.providerThreadId || !previous?.ok || previous.session.id !== sessionId
    || previous.session.ownerId !== principal.userId || previous.session.kind !== "agent"
    || previous.session.agent !== "codex" || previous.session.projectSlug !== thread.projectId) {
    throw new Error("Workspace provider conversation recovery unavailable");
  }
  signal.throwIfAborted();
  const restarted = await runtime.startSession({
    ownerScope: { type: "user", id: principal.userId }, recoveryThreadId: thread.id,
    request: {
      sessionId, providerThreadId: resumeState.providerThreadId, kind: "agent", agent: "codex", prompt,
      attachments: turn.attachments, model: turn.model, modelOptions: turn.modelOptions,
      projectSlug: thread.projectId, worktreeId: previous.session.worktreeId, taskId: thread.taskId,
      approvalPolicy: turn.approvalPolicy ?? "on_request", sandboxMode: turn.sandboxMode ?? "workspace_write",
      runtimePreference: "zellij",
    },
  });
  if (!restarted.ok) throw new Error("Workspace provider turn recovery failed");
  return restarted.session;
}
