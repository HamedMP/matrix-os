import { beginNativeBrowserBootstrap, markNativeBrowserCleanupUnconfirmed, nativeBrowserExecution } from "../chat/native-browser-execution-context.js";
import { prepareCodexBrowser } from "./codex-browser-bootstrap-client.js";
import { isSessionStopConfirmed } from "./session-start-cleanup-proof.js";
import { recoverCodexWorkspace } from "./codex-workspace-recovery.js";
import type { CodingAgentProviderAdapter, CodingAgentProviderRunResult } from "./provider-adapter.js";
import type { WorkspaceCodingAgentProviderOptions } from "./workspace-provider.js";
import { boundedOperation } from "../bounded-operation.js";
import { setTimeout as delay } from "node:timers/promises";

/** A new owner follow-up may cold-resume retained history under freshly verified
 * current consent. Never adopt an old live process or replace a known binding.
 */
export async function recoverLegacyCodexContinuation(
  options: WorkspaceCodingAgentProviderOptions,
  context: Parameters<NonNullable<CodingAgentProviderAdapter["resumeTurn"]>>[0],
  sessionId: string,
  prompt: string,
): Promise<CodingAgentProviderRunResult | undefined> {
  const { principal, resumeState, signal, publishEvents } = context;
  if (options.agent !== "codex" || !options.codexAdmission || resumeState.nativeAccountBinding) return undefined;
  // Ordinary API-key execution has no native binding and keeps its existing path.
  const expectedBinding = await options.codexAdmission.start(principal.userId);
  if (!expectedBinding) return undefined;
  const { runtime, codexAdmission: admission, codexEvents: events, codexControl: control } = options;
  if (!resumeState.providerThreadId || !resumeState.backgroundRef || !runtime.withSessionStart
    || !runtime.confirmStoppedSession || !events || !control || !publishEvents) {
    throw new Error("Legacy conversation recovery is unavailable");
  }
  signal.throwIfAborted();
  return runtime.withSessionStart(principal.userId, sessionId, async scope => {
    const previous = await runtime.getSession?.(sessionId);
    if (!previous?.ok || previous.session.id !== sessionId || previous.session.ownerId !== principal.userId
      || previous.session.kind !== "agent" || previous.session.agent !== "codex"
      || previous.session.projectSlug !== context.thread.projectId
      || previous.session.backgroundRef?.id !== resumeState.backgroundRef!.id) {
      throw new Error("Legacy conversation recovery is unavailable");
    }
    let proof = await runtime.confirmStoppedSession!(principal.userId, sessionId, resumeState.backgroundRef!);
    if (!isSessionStopConfirmed(proof, principal.userId, sessionId) && control.hibernate) {
      // The private runner acknowledges only its exact idle conversation, with
      // no active turn, queued prompt or pending human control. Never force-kill.
      await boundedOperation(() => control.hibernate!({ sessionId, providerThreadId: resumeState.providerThreadId!,
        clientRequestId: `req_legacy_${context.turn.turnId}` }), 5_000, signal);
      proof = await boundedOperation(async waitSignal => {
        for (;;) {
          waitSignal.throwIfAborted();
          const stopped = await runtime.confirmStoppedSession!(principal.userId, sessionId, resumeState.backgroundRef!);
          if (isSessionStopConfirmed(stopped, principal.userId, sessionId)) return stopped;
          await delay(50, undefined, { signal: waitSignal });
        }
      }, 5_000, signal);
    }
    if (!isSessionStopConfirmed(proof, principal.userId, sessionId)) throw new Error("Legacy conversation recovery is unavailable");
    signal.throwIfAborted();
    // Recheck fresh identity/consent after the asynchronous liveness proof.
    const binding = await admission.start(principal.userId, sessionId);
    if (binding !== expectedBinding) throw new Error("Selected Codex account is unavailable");
    const recoveredState = { ...resumeState, nativeAccountBinding: binding };
    const browser = nativeBrowserExecution(principal.userId);
    if (browser && !control.prepareBrowser) throw new Error("Browser startup unavailable");
    const observation = await events.watch({ principal, threadId: context.thread.id, sessionId, startAtEnd: true, checkpoint: true });
    const startup = browser ? beginNativeBrowserBootstrap(principal.userId) : undefined;
    const recoverySignal = startup ? AbortSignal.any([signal, startup.signal]) : signal;
    try {
      // Persist authorization before dispatch, so a restart never needs to guess.
      if (await publishEvents({ events: [], resumeState: recoveredState }) !== true) {
        throw new Error("Legacy conversation binding persistence is unavailable");
      }
      recoverySignal.throwIfAborted();
      await admission.validate(principal.userId, binding, sessionId);
      const session = await recoverCodexWorkspace({ ...runtime, startSession: scope.startSession },
        { ...context, signal: recoverySignal, resumeState: recoveredState }, sessionId, prompt,
        browser ? () => markNativeBrowserCleanupUnconfirmed(principal.userId) : undefined);
      if (session.runtime.type !== "background" || !session.backgroundRef) throw new Error("Legacy conversation recovery is unavailable");
      if (browser) await prepareCodexBrowser({ ownerId: principal.userId, sessionId, browser, control, runtime, signal: recoverySignal });
      return { events: [], outcome: "delivered", resumeState: { ...recoveredState,
        backgroundRef: session.backgroundRef,
        ...(observation.offset !== undefined ? { eventOffset: observation.offset } : {}),
      } };
    } catch (error: unknown) {
      events.unwatch(sessionId);
      throw error;
    } finally { startup?.finish(); }
  });
}
