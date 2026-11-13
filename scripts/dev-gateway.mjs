#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import { localServiceProcesses } from "./dev-local.mjs";
import { spawnServices } from "./source-processes.mjs";

// Docker has already prepared dependencies and initial builds. Own the same
// Kernel compiler and Gateway watchers as dev:source, without starting infra.
export async function startGatewayDevelopment() {
  const services = spawnServices(localServiceProcesses.filter(({ name }) => (
    name === "kernel-build" || name === "gateway"
  )));
  let stoppedBySignal;
  let cancel;
  const cancelled = new Promise(resolve => { cancel = resolve; });
  const handlers = ["SIGINT", "SIGTERM"].map(signal => [signal, () => {
    stoppedBySignal ??= signal;
    cancel();
  }]);
  for (const [signal, handler] of handlers) process.on(signal, handler);
  try {
    const status = await Promise.race([services.exited, cancelled]);
    if (!stoppedBySignal) {
      throw new Error(`${status.name} (pid ${status.pid ?? "unknown"}) stopped unexpectedly`);
    }
  } catch (error) {
    if (!stoppedBySignal) throw error;
  } finally {
    try { await services.stop(stoppedBySignal ?? "SIGTERM"); }
    finally { for (const [signal, handler] of handlers) process.off(signal, handler); }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startGatewayDevelopment().catch(error => {
    console.error(`Gateway development failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
