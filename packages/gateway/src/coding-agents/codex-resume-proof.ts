import type { CodingAgentProviderAdapter } from "./provider-adapter.js";
import type { WorkspaceSessionOrchestrator } from "../workspace-session-orchestrator.js";
import type { CodexControlClient } from "./codex-control-client.js";
import type { CodexExecutionAdmission } from "./codex-execution-admission.js";
import type { BackgroundAgentRuntime } from "../background-agent-runtime.js";

type Input = Parameters<NonNullable<CodingAgentProviderAdapter["prepareHistoryResume"]>>[0];

/** Stops only an idle or already-stopped exact incarnation; never interrupts uncertain work. */
export async function proveCodexResumeStopped(input: Input, options: {
  runtime: Partial<Pick<WorkspaceSessionOrchestrator, "getSession" | "withSessionStart">>;
  control?: CodexControlClient;
  backgroundRuntime?: Pick<BackgroundAgentRuntime, "isRunning" | "stop">;
  admission?: CodexExecutionAdmission;
}): Promise<boolean> {
  const { principal, thread, resumeState, signal } = input;
  signal.throwIfAborted();
  const sessionId = `sess_${thread.id.slice("thread_".length)}`;
  if (resumeState.conversationId !== sessionId || !resumeState.providerThreadId || !resumeState.backgroundRef
    || !options.runtime.getSession || !options.runtime.withSessionStart || !options.control?.hibernate || !options.backgroundRuntime) return false;
  return options.runtime.withSessionStart(principal.userId, sessionId, async () => {
  await options.admission?.validate(principal.userId, resumeState.nativeAccountBinding, sessionId);
  signal.throwIfAborted();
  const readExact = async () => {
    const current = await options.runtime.getSession!(sessionId);
    signal.throwIfAborted();
    if (!current.ok || current.session.id !== sessionId || current.session.ownerId !== principal.userId
      || current.session.kind !== "agent" || current.session.agent !== "codex"
      || current.session.projectSlug !== thread.projectId || current.session.runtime.type !== "background"
      || current.session.backgroundRef?.id !== resumeState.backgroundRef!.id) throw new Error("Native resume identity unavailable");
    return current.session;
  };
  await readExact();
  const capturedRef = resumeState.backgroundRef!;
  const alive = await options.backgroundRuntime!.isRunning(capturedRef);
  signal.throwIfAborted();
  if (typeof alive !== "boolean") return false;
  if (alive !== false) {
    // The handshake reserves the idle boundary against queued input synchronously.
    await options.control!.hibernate!({ sessionId, providerThreadId: resumeState.providerThreadId!,
      clientRequestId: `req_resume_${thread.id.slice("thread_".length)}` });
    signal.throwIfAborted();
  }
  await readExact();
  await options.backgroundRuntime!.stop(capturedRef);
  signal.throwIfAborted();
  await readExact();
  const stillRunning = await options.backgroundRuntime!.isRunning(capturedRef);
  signal.throwIfAborted();
  return stillRunning === false;
  });
}
