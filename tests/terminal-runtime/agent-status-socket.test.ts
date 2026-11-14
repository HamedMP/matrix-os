import { createUnixSocketTempDir } from "../helpers/unix-socket-temp.js";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TerminalRuntimeSocketClient } from "../../packages/terminal-runtime/src/socket-client.js";
import { TerminalRuntimeSocketServer } from "../../packages/terminal-runtime/src/socket-server.js";

const directories: string[] = [];
const servers: TerminalRuntimeSocketServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function serve(agentStatus?: { list(): Promise<unknown[]> }) {
  const directory = await createUnixSocketTempDir();
  directories.push(directory);
  const socketPath = join(directory, "terminal-runtime.sock");
  const server = new TerminalRuntimeSocketServer({
    socketPath,
    runtime: { listWorkspaces: async () => [] } as never,
    ...(agentStatus ? { agentStatus } : {}),
  });
  servers.push(server);
  await server.start();
  return new TerminalRuntimeSocketClient({ socketPath });
}

const entry = {
  ref: { workspaceId: `tws_${"0".repeat(32)}`, tabId: `tt_${"1".repeat(32)}` },
  status: "blocked",
  message: "Allow edit?",
  reportedAt: "2026-11-11T10:00:00.000Z",
  source: "hook",
};

// Fault detected: the gateway cannot learn per-tab status from the runtime that owns pane identity.
describe("terminal runtime agent status over the socket", () => {
  it("returns the runtime's per-tab statuses", async () => {
    const client = await serve({ list: async () => [entry] });
    await expect(client.listAgentStatuses()).resolves.toEqual([entry]);
  });

  it("returns statuses for more than 1,024 tabs", async () => {
    const many = Array.from({ length: 1_500 }, (_, i) => ({ ...entry, ref: { ...entry.ref, tabId: `tt_${i.toString(16).padStart(32, "0")}` } }));
    const client = await serve({ list: async () => many });
    await expect(client.listAgentStatuses()).resolves.toHaveLength(1_500);
  });

  it("returns nothing when the runtime has no status index", async () => {
    const client = await serve();
    await expect(client.listAgentStatuses()).resolves.toEqual([]);
  });

  it("rejects malformed entries instead of passing them to clients", async () => {
    const client = await serve({ list: async () => [{ ...entry, status: "dancing" }] });
    await expect(client.listAgentStatuses()).rejects.toThrow();
  });
});
