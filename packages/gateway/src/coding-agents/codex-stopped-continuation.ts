import { beginNativeBrowserBootstrap, markNativeBrowserCleanupUnconfirmed, nativeBrowserExecution } from "../chat/native-browser-execution-context.js";
import { prepareCodexBrowser } from "./codex-browser-bootstrap-client.js";
import { isSessionStopConfirmed } from "./session-start-cleanup-proof.js";
import { recoverCodexWorkspace } from "./codex-workspace-recovery.js";
import type { CodingAgentProviderAdapter, CodingAgentProviderRunResult } from "./provider-adapter.js";
import type { WorkspaceCodingAgentProviderOptions } from "./workspace-provider.js";
import { boundedOperation } from "../bounded-operation.js";
import { setTimeout as delay } from "node:timers/promises";

/** An owner follow-up may cold-resume retained history under freshly verified
 * current consent. A changed binding requires a proved stopped old process.
 */
export async function recoverStoppedCodexContinuation(
  options: WorkspaceCodingAgentProviderOptions,
  context: Parameters<NonNullable<CodingAgentProviderAdapter["resumeTurn"]>>[0],
  sessionId: string,
  prompt: string,
): Promise<CodingAgentProviderRunResult | undefined> {
  const { principal, resumeState, signal, publishEvents } = context;
  if (options.agent !== "codex" || !options.codexAdmission) return undefined;
  // Ordinary API-key execution has no native binding and keeps its existing path.
  const expectedBinding = await options.codexAdmission.start(principal.userId);
  if (!expectedBinding) return undefined;
  if (resumeState.nativeAccountBinding === expectedBinding) return undefined;
  const changedAccount = !!resumeState.nativeAccountBinding;
  const { runtime, codexAdmission: admission, codexEvents: events, codexControl: control } = options;
  if (!resumeState.providerThreadId || !resumeState.backgroundRef || !runtime.withSessionStart
    || !runtime.confirmStoppedSession || !events || !control || !publishEvents) {
    throw new Error("Codex conversation recovery is unavailable");
  }
  signal.throwIfAborted();
  return runtime.withSessionStart(principal.userId, sessionId, async scope => {
    const previous = await runtime.getSession?.(sessionId);
    if (!previous?.ok || previous.session.id !== sessionId || previous.session.ownerId !== principal.userId
      || previous.session.kind !== "agent" || previous.session.agent !== "codex"
      || previous.session.projectSlug !== context.thread.projectId
      || previous.session.backgroundRef?.id !== resumeState.backgroundRef!.id) {
      throw new Error("Codex conversation recovery is unavailable");
    }
    let proof = await runtime.confirmStoppedSession!(principal.userId, sessionId, resumeState.backgroundRef!);
    if (!changedAccount && !isSessionStopConfirmed(proof, principal.userId, sessionId) && control.hibernate) {
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
    if (!isSessionStopConfirmed(proof, principal.userId, sessionId)) throw new Error("Codex conversation recovery is unavailable");
    signal.throwIfAborted();
    // Recheck fresh identity/consent after the asynchronous liveness proof.
    const proveStopped = async (proofSignal: AbortSignal) => {
      proofSignal.throwIfAborted();
      const current = await runtime.confirmStoppedSession!(principal.userId, sessionId, resumeState.backgroundRef!);
      proofSignal.throwIfAborted();
      return isSessionStopConfirmed(current, principal.userId, sessionId);
    };
    const binding = changedAccount
      ? await admission.renewStoppedSession(principal.userId, resumeState.nativeAccountBinding!, sessionId, proveStopped)
      : expectedBinding;
    if (binding !== expectedBinding) throw new Error("Selected Codex account is unavailable");
    await admission.validate(principal.userId, binding, sessionId);
    let recoveredState = { ...resumeState, nativeAccountBinding: binding };
    const browser = nativeBrowserExecution(principal.userId);
    if (browser && !control.prepareBrowser) throw new Error("Browser startup unavailable");
    const startup = browser ? beginNativeBrowserBootstrap(principal.userId) : undefined;
    const recoverySignal = startup ? AbortSignal.any([signal, startup.signal]) : signal;
    let observation: Awaited<ReturnType<typeof events.watch>> | undefined;
    try {
      // Persist authorization before observation and dispatch, so transcript
      // recovery validates the newly authorized binding instead of the stale one.
      if (await publishEvents({ events: [], resumeState: recoveredState }) !== true) {
        throw new Error("Codex conversation binding persistence is unavailable");
      }
      observation = await events.watch({
        principal, threadId: context.thread.id, sessionId, startAtEnd: true, checkpoint: true,
        ...(recoveredState.eventGeneration ? { generation: recoveredState.eventGeneration } : {}),
        resume: { turnId: context.turn.turnId, resumeState: recoveredState, proveStopped },
      });
      recoveredState = {
        ...recoveredState,
        ...(observation.generation ? { eventGeneration: observation.generation, eventStreamInterrupted: false } : {}),
        ...(observation.offset !== undefined ? { eventOffset: observation.offset } : {}),
      };
      recoverySignal.throwIfAborted();
      await admission.validate(principal.userId, binding, sessionId);
      const session = await recoverCodexWorkspace({ ...runtime, startSession: scope.startSession },
        { ...context, signal: recoverySignal, resumeState: recoveredState }, sessionId, prompt,
        browser ? () => markNativeBrowserCleanupUnconfirmed(principal.userId) : undefined);
      if (session.runtime.type !== "background" || !session.backgroundRef) throw new Error("Codex conversation recovery is unavailable");
      if (browser) await prepareCodexBrowser({ ownerId: principal.userId, sessionId, browser, control, runtime, signal: recoverySignal });
      return { events: [], outcome: "delivered", resumeState: { ...recoveredState,
        backgroundRef: session.backgroundRef,
      } };
    } catch (error: unknown) {
      if (observation?.watchId) events.unwatch(sessionId, observation.watchId);
      throw error;
    } finally { startup?.finish(); }
  });
}
