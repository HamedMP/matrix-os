import { serve } from "@hono/node-server";

import { createFundedRelayService, requireFundedRelayServiceConfig } from "./funded-main-app.js";
import { configureProxyServerTimeouts } from "./server-timeouts.js";
import { RELAY_SHUTDOWN_FORCE_EXIT_MS, RELAY_SHUTDOWN_TIMEOUT_MS } from "./funded-relay-lifecycle.js";

const DEFAULT_PORT = 8080;

function readPort(env: NodeJS.ProcessEnv): number {
  const raw = env.PORT ?? env.PROXY_PORT;
  if (raw === undefined || raw === "") return DEFAULT_PORT;
  const port = Number(raw);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }
  return port;
}

const port = readPort(process.env);
const service = createFundedRelayService(requireFundedRelayServiceConfig(process.env));
const server = serve({ fetch: service.app.fetch, port }, () => {
  console.log(`[funded-ai-relay] Listening on :${port}`);
});
configureProxyServerTimeouts(server);

let isShuttingDown = false;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`[funded-ai-relay] Received ${signal}, shutting down`);
  server.close();
  const deadline = AbortSignal.timeout(RELAY_SHUTDOWN_TIMEOUT_MS);
  const forceExit = setTimeout(() => process.exit(1), RELAY_SHUTDOWN_FORCE_EXIT_MS);
  let completed = false;
  try {
    completed = await service.close(deadline);
  } catch (error: unknown) {
    const errorName = error instanceof Error ? error.name : "UnknownError";
    console.warn("[funded-ai-relay] Failed during shutdown", { errorName });
  } finally {
    clearTimeout(forceExit);
    if (!completed) console.warn("[funded-ai-relay] Shutdown incomplete");
    process.exit(completed ? 0 : 1);
  }
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
