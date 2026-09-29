/**
 * Entry point of the bundled bot worker (`dist/bot-worker.mjs`), mounted
 * read-only at /opt/matrix/scope-sdk/bot-runtime in a `scope-runtime-bot-v1`
 * workload. The scope runtime owns the boundary checks, the inference bridge,
 * and the command socket; this file supplies the Pi-based command handler.
 */
import { fileURLToPath, pathToFileURL } from "node:url";
import { scopeRuntimeWorkerFailureExitCode } from "@matrix-os/scope-runtime/worker-common";
import {
  ScopeRuntimeBotCommandError,
  runScopeRuntimeBotWorker,
  type ScopeRuntimeBotHandler,
  type ScopeRuntimeBotHandlerContext,
} from "@matrix-os/scope-runtime/worker-bot";
import { createBotBrokerClient, type BotWorkerBrokerClient } from "./broker-client.js";
import { BotWorkerError, createBotWorker } from "./worker.js";

export function createBotCommandHandler(
  context: ScopeRuntimeBotHandlerContext,
  brokerFor: (runId: string) => BotWorkerBrokerClient = (runId) => createBotBrokerClient({
    socketPath: context.brokerSocket,
    runtimeHandle: context.runtimeHandle,
    executionGeneration: context.executionGeneration,
    runId,
  }),
): ScopeRuntimeBotHandler {
  const worker = createBotWorker({ bridgeOrigin: context.bridgeOrigin, brokerFor });
  return {
    async handle(command) {
      try {
        return { ...(await worker.handle(command)) };
      } catch (error: unknown) {
        if (error instanceof BotWorkerError) throw new ScopeRuntimeBotCommandError(error.code);
        throw error;
      }
    },
    shutdown: () => worker.shutdown(),
  };
}

export async function runBotWorkerEntry(args?: readonly string[]): Promise<void> {
  await runScopeRuntimeBotWorker({
    entryFile: fileURLToPath(import.meta.url),
    ...(args ? { args } : {}),
    createHandler: (context) => createBotCommandHandler(context),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runBotWorkerEntry().catch((error: unknown) => {
    console.error("scope_runtime_bot_worker_failed:", error instanceof Error ? error.name : "UnknownError");
    process.exitCode = scopeRuntimeWorkerFailureExitCode(error);
  });
}
