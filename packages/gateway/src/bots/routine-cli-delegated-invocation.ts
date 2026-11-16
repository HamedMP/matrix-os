import { RoutineCliOperationSchema, type BotToolRequest, type BotToolResult } from "@matrix-os/contracts";
import type { NativeRoutineCliPort } from "../chat/claude-routine-execution.js";
import type { BotRuntimeBinding } from "./runtime-registry.js";
import type { CanonicalProviderRunEvent } from "../chat/provider-adapter.js";
import { createFixedNativeRoutineCliInvoker } from "./routine-cli-invoker.js";
/** Existing typed routine tool -> same fixed published CLI; no shell, identity flags or direct backend. */
export async function openDelegatedRoutineCli(options: Omit<NativeRoutineCliPort, "runtime"> & { runtime: Pick<import("./routine-cli-runtime.js").RoutineCliRuntime, "registerBotChild">;
  binding: BotRuntimeBinding; signal: AbortSignal; current(): boolean; publish(event: CanonicalProviderRunEvent): void; homePath: string; cwd: string }) {
  const source = await options.runtime.registerBotChild(options);
  if (options.signal.aborted || !options.current()) { await source.revoke(); throw new Error("Routine source unavailable"); }
  let cli: ReturnType<typeof createFixedNativeRoutineCliInvoker>;
  try { cli = createFixedNativeRoutineCliInvoker({ ...source, binPath: options.binPath, endpoint: options.endpoint, homePath: options.homePath, cwd: options.cwd, timeoutMs: 120_000 }); }
  catch (error: unknown) { await source.revoke(); throw error; }
  return { async call(request: BotToolRequest, signal: AbortSignal): Promise<BotToolResult> {
    if (request.capability !== "routine.propose" && request.capability !== "routine.control") throw new Error("Routine intent unavailable");
    const operation = RoutineCliOperationSchema.parse(request.capability === "routine.propose" ? { operation: "propose", requestId: request.routineRequestId, proposal: request.args }
      : request.args.operation === "list" ? { operation: "list" } : { operation: request.args.status === "active" ? "resume" : request.args.status === "paused" ? "pause" : "archive",
        routineId: request.args.routineId, baseRevision: request.args.baseRevision, requestId: request.routineRequestId });
    if (operation.operation === "show" || operation.operation === "request") throw new Error("Routine intent unavailable");
    const args = operation.operation === "list" ? ["list"] : operation.operation === "propose" ? ["propose", "--input", "-", "--request-id", operation.requestId]
      : [operation.operation, operation.routineId, "--revision", String(operation.baseRevision), "--request-id", operation.requestId];
    const result = await cli.invoke({ args, ...(operation.operation === "propose" ? { stdin: JSON.stringify(operation.proposal) } : {}), expectedOperation: operation, signal: AbortSignal.any([signal, options.signal]) });
    return { ok: true, content: [{ type: "text", text: JSON.stringify(result) }] };
  }, async close() { await cli.close(); await source.revoke(); } };
}
