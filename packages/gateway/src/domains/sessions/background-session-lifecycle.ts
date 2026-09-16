import type { AgentLaunchSpec } from "./agent-launcher.js";
import type { WorkspaceSession } from "./agent-session-manager.js";
import { BackgroundSessionRunningError, type BackgroundAgentRuntime } from "./background-agent-runtime.js";

/** Persist ownership before dispatch; ambiguous startup must retain scratch and its lease. */
export async function startBackgroundSession(options: {
  runtime: BackgroundAgentRuntime;
  session: WorkspaceSession;
  launch: AgentLaunchSpec;
  persist: (session: WorkspaceSession) => Promise<void>;
}) {
  let prepared: WorkspaceSession | undefined;
  let confirmedStopped = false;
  try {
    const ref = await options.runtime.start({
      sessionId: options.session.id,
      launch: options.launch,
      onPrepared: async (backgroundRef) => {
        prepared = { ...options.session, backgroundRef, runtime: { ...options.session.runtime, status: "starting" } };
        await options.persist(prepared);
      },
    });
    const session = { ...options.session, backgroundRef: ref };
    try {
      await options.persist(session);
    } catch (error: unknown) {
      await options.runtime.stop(ref);
      confirmedStopped = true;
      throw error;
    }
    return { ok: true as const, session };
  } catch (error: unknown) {
    console.warn("[background-session] startup failed", { errorType: error instanceof Error ? error.name : "UnknownError" });
    if (error instanceof BackgroundSessionRunningError) return { ok: false as const, retainWorkspace: true };
    if (prepared?.backgroundRef && !confirmedStopped) {
      try {
        await options.runtime.stop(prepared.backgroundRef);
        confirmedStopped = true;
      } catch (stopError: unknown) {
        console.warn("[background-session] retaining ownership until stop is confirmed", {
          errorType: stopError instanceof Error ? stopError.name : "UnknownError",
        });
      }
    }
    return { ok: false as const, retainWorkspace: !!prepared && !confirmedStopped };
  }
}
