import type { WorkspaceSession } from "../agent-session-manager.js";
import type { BackgroundAgentRef, BackgroundAgentRuntime } from "../background-agent-runtime.js";
import { BackgroundAgentRefSchema } from "../background-agent-runtime.js";
import { boundedOperation } from "../bounded-operation.js";
import { markSessionStopConfirmed } from "./session-start-cleanup-proof.js";

/** Internal recovery only: callers hold the shared session-start reservation.
 * A persisted status, missing descriptor or failed probe cannot prove a stop.
 * This never kills a process or removes its retained workspace/transcript.
 */
export async function confirmStoppedCodexSession(input: {
  ownerId: string;
  sessionId: string;
  expectedRef: BackgroundAgentRef;
  readSession(): Promise<WorkspaceSession | null>;
  runtime?: Pick<BackgroundAgentRuntime, "isRunning">;
}): Promise<object | undefined> {
  if (!/^sess_[A-Za-z0-9_-]{1,128}$/.test(input.sessionId)
    || !BackgroundAgentRefSchema.safeParse(input.expectedRef).success) return undefined;
  const matches = (session: WorkspaceSession | null): boolean => Boolean(session
    && session.id === input.sessionId && session.ownerId === input.ownerId
    && session.kind === "agent" && session.agent === "codex"
    && session.runtime.type === "background" && session.backgroundRef?.id === input.expectedRef.id);
  if (!input.runtime || !matches(await input.readSession())) return undefined;
  if (await boundedOperation(() => input.runtime!.isRunning(input.expectedRef), 5_000)) return undefined;
  if (!matches(await input.readSession())) return undefined;
  return markSessionStopConfirmed({}, input.ownerId, input.sessionId);
}
