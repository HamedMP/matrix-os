import { createScopeRuntimeServer } from "./server.js";
import { createScopeRuntimeController } from "./supervisor.js";
import { createSystemdScopeRuntimeLauncher, nextExecutionGeneration } from "./systemd-launcher.js";

const RUNTIME_DIRECTORY = "/run/matrix-scope-runtime";
const STATE_DIRECTORY = "/var/lib/matrix-scope-runtime";

async function main(): Promise<void> {
  const launcher = createSystemdScopeRuntimeLauncher({
    stateRoot: STATE_DIRECTORY,
    sdkDirectory: "/opt/matrix/app/node_modules/@anthropic-ai/claude-agent-sdk",
    nativeDirectory: "/opt/matrix/app/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64",
    workerFile: "/opt/matrix/app/packages/scope-runtime/dist/worker.js",
    brokerSocket: `${RUNTIME_DIRECTORY}/broker.sock`,
  });
  const executionGeneration = await nextExecutionGeneration(`${STATE_DIRECTORY}/generation`);
  const controller = await createScopeRuntimeController({ launcher, executionGeneration });
  const server = createScopeRuntimeServer({
    socketPath: `${RUNTIME_DIRECTORY}/supervisor.sock`,
    controller,
  });
  await server.start();
  process.stdout.write("scope_runtime_supervisor_ready\n");

  let shutdown: Promise<void> | undefined;
  const stop = () => {
    shutdown ??= server.close();
    void shutdown.then(() => {
      process.exitCode = 0;
    }).catch((error: unknown) => {
      console.error("scope_runtime_supervisor_shutdown_failed:",
        error instanceof Error ? error.name : "UnknownError");
      process.exitCode = 1;
    });
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}

main().catch((error: unknown) => {
  console.error("scope_runtime_supervisor_failed:", error instanceof Error ? error.name : "UnknownError");
  process.exitCode = 1;
});
