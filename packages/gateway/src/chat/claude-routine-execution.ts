import type { RoutineCliRuntime } from "../bots/routine-cli-runtime.js";
import { createFixedNativeRoutineCliInvoker } from "../bots/routine-cli-invoker.js";
import { createRoutineResultArtifacts, RoutineDisplayUnavailableError, routineDisplayRequestId } from "./routine-result-artifacts.js";
import { parseClaudeRoutineCommand } from "./claude-routine-command.js";
import type { CanonicalProviderRunInput, CanonicalProviderRunEvent } from "./provider-adapter.js";
export interface NativeRoutineCliPort { runtime: Pick<RoutineCliRuntime, "registerChat">; binPath: string; endpoint: string }
/** Actual execute closure owns the source, fixed child and display lifecycle. Callback completion never ends the source. */
export function createClaudeRoutineExecution(options: NativeRoutineCliPort & { input: CanonicalProviderRunInput; signal: AbortSignal;
  current(): boolean; publish(event: CanonicalProviderRunEvent): void; cwd: string; homePath: string }) {
  let source: ReturnType<RoutineCliRuntime["registerChat"]> | undefined, closed = false;
  let nativePlan = false;
  let invoker: ReturnType<typeof createFixedNativeRoutineCliInvoker> | undefined;
  let artifacts: ReturnType<typeof createRoutineResultArtifacts> | undefined;
  const open = () => {
    source ??= options.runtime.registerChat({ input: options.input, signal: options.signal, current: () => !closed && options.current(), publish: options.publish });
    return source;
  };
  return {
    async execute(command: string, signal: AbortSignal, nativeMode?: string) {
      const parsed = parseClaudeRoutineCommand(command); if (!parsed || closed || options.signal.aborted || signal.aborted) throw new Error("Routine source unavailable");
      if (nativeMode === "plan") nativePlan = true;
      const registered = await open(); registered.narrowNativeMode(nativePlan ? "plan" : undefined);
      if (closed || options.signal.aborted || signal.aborted) throw new Error("Routine source unavailable");
      invoker ??= createFixedNativeRoutineCliInvoker({ binPath: options.binPath, endpoint: options.endpoint, cwd: options.cwd, homePath: options.homePath,
        authorize: registered.authorize, issue: registered.issue, cancel: registered.cancel, timeoutMs: 120_000 });
      const result = await invoker.invoke({ ...parsed, signal: AbortSignal.any([signal, options.signal]) });
      if (closed || options.signal.aborted || signal.aborted) throw new Error("Routine source unavailable");
      const requestId = routineDisplayRequestId(result);
      try {
        artifacts ??= createRoutineResultArtifacts();
        const display = await (await artifacts).write(result); return { command: display.command, requestId };
      } catch (error: unknown) {
        console.warn("[claude-routines] Display unavailable", error instanceof Error ? error.name : "UnknownError");
        throw new RoutineDisplayUnavailableError(requestId);
      }
    },
    async close() {
      closed = true;
      try { await invoker?.close(); } finally {
        if (source) { try { await (await source).revoke(); } catch (error: unknown) { console.warn("[claude-routines] Source cleanup unavailable", error instanceof Error ? error.name : "UnknownError"); } }
        if (artifacts) await (await artifacts).close();
      }
    },
  };
}
