import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { TerminalRuntimeSocketClient } from "../../packages/terminal-runtime/src/socket-client.js";
import { TerminalRuntimeSocketServer, type TerminalRuntimeControlApi } from "../../packages/terminal-runtime/src/socket-server.js";

const ref = { workspaceId: `tws_${"a".repeat(32)}`, tabId: `tt_${"b".repeat(32)}` };

async function serve(runtime: Partial<TerminalRuntimeControlApi>) {
  const homePath = await mkdtemp(join(tmpdir(), "matrix-capture-socket-"));
  const socketPath = join(homePath, "runtime.sock");
  const server = new TerminalRuntimeSocketServer({ socketPath, runtime: runtime as TerminalRuntimeControlApi });
  await server.start();
  return {
    client: new TerminalRuntimeSocketClient({ socketPath }),
    close: async () => { await server.close(); await rm(homePath, { recursive: true, force: true }); },
  };
}

describe("terminal screen capture over the runtime socket", () => {
  // Fault detected: the gateway keeps reading a frozen snapshot because the live capture never crosses the socket.
  it("returns the runtime's live capture for a tab", async () => {
    const captureScreen = vi.fn(async () => ({ viewport: ["$ ls", "a b", "$ "], scrollback: ["older"] }));
    const f = await serve({ captureScreen });
    try {
      await expect(f.client.captureScreen(ref, 1)).resolves.toEqual({ viewport: ["$ ls", "a b", "$ "], scrollback: ["older"] });
      expect(captureScreen).toHaveBeenCalledWith({ ...ref, lines: 1 });
    } finally { await f.close(); }
  });

  // Fault detected: a gateway newer than its runtime (mid-update) fails reads instead of using the snapshot.
  it("reports no capture when the runtime cannot capture", async () => {
    const f = await serve({ captureScreen: async () => null });
    try {
      await expect(f.client.captureScreen(ref, 0)).resolves.toBeNull();
    } finally { await f.close(); }
    const older = await serve({});
    try {
      await expect(older.client.captureScreen(ref, 0)).resolves.toBeNull();
    } finally { await older.close(); }
  });

  it("refuses history beyond the read limit before asking the runtime", async () => {
    const captureScreen = vi.fn(async () => null);
    const f = await serve({ captureScreen });
    try {
      await expect(f.client.captureScreen(ref, 10_001)).rejects.toThrow();
      expect(captureScreen).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });
});
