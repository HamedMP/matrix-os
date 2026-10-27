import type { WorkspaceSessionOrchestrator } from "../workspace-session-orchestrator.js";
import type { CodexControlClient } from "./codex-control-client.js";
import type { ProviderIdleObservation } from "./provider-transcript-recovery.js";
import type { BackgroundAgentRuntime } from "../background-agent-runtime.js";

/** An idle socket cannot authorize recovery for a replaced workspace incarnation. */
export function createCodexExecutionIdleProof(options: {
  sessions: () => Pick<WorkspaceSessionOrchestrator, "getSession"> | null | undefined;
  control: Pick<CodexControlClient, "isExecutionIdle">;
  backgroundRuntime?: Pick<BackgroundAgentRuntime, "isRunning">;
}) {
  return async (observation: ProviderIdleObservation): Promise<boolean> => {
    const sessions = options.sessions();
    if (!sessions) return false;
    const currentSessions = sessions;
    async function matchesCurrentIncarnation() {
      const result = await currentSessions.getSession(observation.sessionId);
      return result.ok && result.session.id === observation.sessionId && result.session.ownerId === observation.ownerId
        && result.session.kind === "agent" && result.session.agent === "codex" && result.session.runtime.type === "background"
        && result.session.backgroundRef?.id === observation.backgroundRefId;
    }
    if (!await matchesCurrentIncarnation()) return false;
    const idle = await options.control.isExecutionIdle?.(observation) ?? false;
    // An old runner may lack the private idle control. Only a successful probe
    // of its exact retained background reference can establish that it stopped.
    if (!idle && (!options.backgroundRuntime
      || await options.backgroundRuntime.isRunning({ id: observation.backgroundRefId }))) return false;
    return matchesCurrentIncarnation();
  };
}
