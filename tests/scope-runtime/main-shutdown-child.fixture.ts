import { join } from "node:path";
import { createScopeRuntimeServer } from "../../packages/scope-runtime/src/server.js";
import { installSupervisorShutdownHandlers } from "../../packages/scope-runtime/src/supervisor-shutdown.js";
import { startScopeRuntimeWatchdog } from "../../packages/scope-runtime/src/systemd-watchdog.js";

const root = process.argv[2]!;
const server = createScopeRuntimeServer({
  socketPath: join(root, "ipc", "service"),
  namespaceTrust: { root, uid: process.getuid!() },
  controller: {
    async handle() { throw new Error("Unexpected dispatch"); },
    close() { console.log("controller closed"); },
  },
});
await server.start();
const watchdog = startScopeRuntimeWatchdog({ env: {} });
installSupervisorShutdownHandlers(watchdog, server);
console.log("ready");
