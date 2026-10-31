import { MatrixComputerListSchema, RoutineActionIdSchema, RoutineActionViewSchema, routineActionConfirmationUrl } from "@matrix-os/contracts";
import { useConnection } from "../../stores/connection";
import { invoke } from "../../lib/operator";
import type { RoutineActionRequest } from "@matrix-os/ui";
async function destination() {
  const connection = useConnection.getState(), api = connection.api;
  if (connection.status !== "signed-in" || !api || !connection.platformHost) throw new Error("Confirmation unavailable");
  const current = () => { const next = useConnection.getState(); return next.api === api && next.authGeneration === connection.authGeneration && next.runtimeSlot === connection.runtimeSlot && next.userId === connection.userId; };
  const computers = MatrixComputerListSchema.parse(await invoke("runtime:list-computers", {}));
  const computer = computers.items.find(item => item.runtimeSlot === connection.runtimeSlot);
  if (!current() || !computer || computer.availability !== "available") throw new Error("Confirmation unavailable");
  // Validate the descriptor's path/origin even for reads. No root default or arbitrary model URL.
  routineActionConfirmationUrl(connection.platformHost, computer.gatewayPath, `rcact_${"0".repeat(32)}`);
  const gateway = new URL(computer.gatewayPath, connection.platformHost), runtime = gateway.searchParams.get("runtime");
  const prefix = gateway.pathname + (runtime ? `/~runtime/${runtime}` : "");
  return { api: api.forRuntime("primary"), current, computer, connection, prefix };
}
export const desktopRoutineActionRequest: RoutineActionRequest = async input => {
  input.signal.throwIfAborted(); const target = await destination(); input.signal.throwIfAborted();
  const options = { signal: input.signal, timeoutMs: 10_000, maxBytes: 128 * 1024 }, path = target.prefix + input.path;
  const result = input.method === "GET" ? await target.api.get(path, options) : await target.api.post(path, input.body, options);
  if (!target.current() || input.signal.aborted) throw new Error("Confirmation unavailable"); return result;
};
/** Owner-button path only. Browser opening carries opaque selectors and never submits a decision. */
export async function openDesktopRoutineConfirmation(challengeId: string, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted(); RoutineActionIdSchema.parse(challengeId); const target = await destination(); signal?.throwIfAborted();
  const challenge = RoutineActionViewSchema.parse(await target.api.get(`${target.prefix}/api/routine-cli/actions/${challengeId}`, { signal, maxBytes: 32 * 1024, timeoutMs: 10_000 }));
  signal?.throwIfAborted();
  if (!target.current() || challenge.challengeId !== challengeId || challenge.status !== "pending" || Date.parse(challenge.expiresAt) <= Date.now()) throw new Error("Confirmation unavailable");
  const url = routineActionConfirmationUrl(target.connection.platformHost, target.computer.gatewayPath, challengeId);
  if (!target.current()) throw new Error("Confirmation unavailable"); await invoke("shell:open-external", { url });
}
