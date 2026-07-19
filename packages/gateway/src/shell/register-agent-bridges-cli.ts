import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { registerAgentBridges } from "./agent-session-bridges.js";

async function main(): Promise<void> {
  const homePath = resolve(process.env.MATRIX_HOME ?? process.env.HOME ?? "");
  if (!homePath) return;
  await registerAgentBridges({
    homePath,
    command: process.env.MATRIX_AGENT_BRIDGE_COMMAND ?? "/opt/matrix/bin/matrix-agent-bridge",
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main().catch((err: unknown) => {
    void err;
    console.warn("[matrix-agent-bridge] registration skipped");
  });
}
