/**
 * Fail-closed construction of the gateway collaboration runtime (S20 / T099).
 *
 * Configuration health can say "configured" while construction still fails
 * (owner Postgres unreachable, migration failure, project inventory setup).
 * Such a failure must never take the whole gateway down: it is logged
 * generically on the server and the composition root mounts the fail-closed
 * collaboration routes instead, so the rest of the gateway keeps serving and
 * collaboration answers with a generic denial until the next restart.
 */
import type { GatewayCollaborationConfigurationFailure } from "./config.js";

export type GatewayCollaborationConstruction<T> =
  | { ok: true; runtime: T }
  | { ok: false; reason: GatewayCollaborationConfigurationFailure };

export async function constructGatewayCollaborationOrFailClosed<T extends { shutdown(): Promise<void> }>(
  build: () => Promise<T>,
  options: { onPartialRuntime?: (runtime: T) => Promise<unknown> } = {},
): Promise<GatewayCollaborationConstruction<T>> {
  let runtime: T | undefined;
  try {
    runtime = await build();
    if (options.onPartialRuntime) await options.onPartialRuntime(runtime);
    return { ok: true, runtime };
  } catch (error: unknown) {
    console.error("[collaboration] runtime construction failed; collaboration routes fail closed",
      error instanceof Error ? error.name : "UnknownError");
    if (runtime) {
      try {
        await runtime.shutdown();
      } catch (shutdownError: unknown) {
        console.warn("[collaboration] partial runtime shutdown failed",
          shutdownError instanceof Error ? shutdownError.name : "UnknownError");
      }
    }
    return { ok: false, reason: "construction_failed" };
  }
}
