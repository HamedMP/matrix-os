import { resolveScopeRuntimeHostConfig, resolveScopeRuntimeSourcePaths } from "./host-config.js";
import { describeScopeRuntimeFailure } from "./failure.js";
import { createScopeRuntimeServer } from "./server.js";
import { createScopeRuntimeController } from "./supervisor.js";
import { createSystemdScopeRuntimeLauncher, nextExecutionGeneration } from "./systemd-launcher.js";
import { botSandboxRootsForHome, managedPiSandboxRootsForHome, sandboxRootsForHome } from "./sandbox.js";
import { startScopeRuntimeWatchdog } from "./systemd-watchdog.js";

async function main(): Promise<void> {
  const home = process.env.MATRIX_HOME ?? "/home/matrix/home";
  const config = resolveScopeRuntimeHostConfig({ env: process.env, homePath: home });
  const launcher = createSystemdScopeRuntimeLauncher({
    namespace: config.namespace,
    commandSocketRoot: config.commandSocketRoot,
    stateRoot: config.stateRoot,
    ...resolveScopeRuntimeSourcePaths(config),
    brokerSocket: config.brokerSocket,
    sandboxRoots: sandboxRootsForHome(home),
    botSandboxRoots: botSandboxRootsForHome(home),
    managedPiSandboxRoots: managedPiSandboxRootsForHome(home),
  });
  const executionGeneration = await nextExecutionGeneration(`${config.stateRoot}/generation`);
  const controller = await createScopeRuntimeController({ launcher, executionGeneration });
  const server = createScopeRuntimeServer({
    socketPath: config.supervisorSocket,
    controller,
  });
  await server.start();
  const watchdog = startScopeRuntimeWatchdog();
  process.stdout.write("scope_runtime_supervisor_ready\n");

  let shutdown: Promise<void> | undefined;
  const stop = () => {
    shutdown ??= (async () => {
      await watchdog.close();
      await server.close();
    })();
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
  console.error("scope_runtime_supervisor_failed:", describeScopeRuntimeFailure(error));
  process.exitCode = 1;
});
