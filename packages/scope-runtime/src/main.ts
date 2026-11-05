import { assertProtectedNodeRoot } from "./node-runtime.js";
import { installSupervisorShutdownHandlers } from "./supervisor-shutdown.js";
import { HOST_NAMESPACE_TRUST, assertRuntimeDirectoryPlacement, assertNamespaceSocket } from "./namespace-ancestry.js";
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
  const namespaceTrust = config.namespace === undefined ? undefined : HOST_NAMESPACE_TRUST;
  if (config.ownedNode) {
    await assertProtectedNodeRoot(config.ownedNode.root);
    if (process.execPath !== config.ownedNode.binary) throw new Error("Supervisor Node executable disagrees with configuration");
  }
  if (namespaceTrust) {
    await assertRuntimeDirectoryPlacement(config);
    await assertNamespaceSocket(config.supervisorSocket, namespaceTrust);
    await assertNamespaceSocket(config.brokerSocket, namespaceTrust);
  }
  const launcher = createSystemdScopeRuntimeLauncher({
    namespace: config.namespace,
    useOwnedNode: !!config.ownedNode,
    commandSocketRoot: config.commandSocketRoot,
    stateRoot: config.stateRoot,
    ...resolveScopeRuntimeSourcePaths(config),
    brokerSocket: config.brokerSocket,
    sandboxRoots: sandboxRootsForHome(home),
    botSandboxRoots: botSandboxRootsForHome(home),
    managedPiSandboxRoots: managedPiSandboxRootsForHome(home),
  });
  const executionGeneration = await nextExecutionGeneration(`${config.stateRoot}/generation`, namespaceTrust);
  const controller = await createScopeRuntimeController({ launcher, executionGeneration });
  const server = createScopeRuntimeServer({
    socketPath: config.supervisorSocket,
    namespaceTrust,
    controller,
  });
  await server.start();
  const watchdog = startScopeRuntimeWatchdog();
  process.stdout.write("scope_runtime_supervisor_ready\n");

  installSupervisorShutdownHandlers(watchdog, server);
}

main().catch((error: unknown) => {
  console.error("scope_runtime_supervisor_failed:", describeScopeRuntimeFailure(error));
  process.exitCode = 1;
});
