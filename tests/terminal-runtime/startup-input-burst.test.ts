import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { TerminalRuntimeSocketClient } from "../../packages/terminal-runtime/src/socket-client.js";
import { TerminalRuntimeSocketServer, type TerminalRuntimeControlApi } from "../../packages/terminal-runtime/src/socket-server.js";

const ref = { workspaceId: `tws_${"a".repeat(32)}`, tabId: `tt_${"b".repeat(32)}` };
const palette = Array.from({ length: 256 }, (_, i) => `\x1b]4;${i};rgb:ffff/ffff/ffff\x1b\\`);

describe("terminal startup input over the real runtime socket", () => {
  it("keeps palette replies sent after attached but before native attachment readiness", async () => {
    const directory = await mkdtemp(join(tmpdir(), "terminal-burst-"));
    const ready = Promise.withResolvers<void>();
    const attached = Promise.withResolvers<void>();
    const received: string[] = [];
    const closed = vi.fn(); const failed = vi.fn(); const detach = vi.fn(async () => undefined);
    const server = new TerminalRuntimeSocketServer({
      socketPath: join(directory, "runtime.sock"),
      runtime: {
        resize: async () => ({ canonicalSize: { cols: 120, rows: 36 }, tabs: [{ id: ref.tabId, revision: 1 }] }),
        getSnapshot: async () => undefined,
        attach: async () => { await ready.promise; return {
          write: async (data: string) => { received.push(data); }, touch: () => undefined, detach,
        }; },
      } as unknown as TerminalRuntimeControlApi,
    });
    await server.start();
    const client = new TerminalRuntimeSocketClient({ socketPath: join(directory, "runtime.sock") });
    const stream = client.attach({ ref, viewerId: "test", mode: "soft", size: { cols: 120, rows: 36 },
      onFrame: frame => { if (frame.type === "attached") attached.resolve(); }, onClose: closed, onError: failed,
    });
    try {
      await attached.promise;
      for (const reply of palette) stream.send({ type: "input", terminalRef: ref, data: reply });
      // Keep native attach pending while every frame reaches the Unix socket.
      await new Promise(resolve => setTimeout(resolve, 40));
      expect(closed).not.toHaveBeenCalled();
      ready.resolve();
      await vi.waitFor(() => expect(received.join("")).toBe(palette.join("")));
      stream.send({ type: "input", terminalRef: ref, data: "printf ready\r" });
      await vi.waitFor(() => expect(received.join("")).toBe(palette.join("") + "printf ready\r"));
      expect(failed).not.toHaveBeenCalled();
      expect(closed).not.toHaveBeenCalled();
    } finally {
      ready.resolve(); stream.close(); await server.close(); await rm(directory, { recursive: true, force: true });
    }
  });
  it("releases a viewer if the client disconnects while native attachment is pending", async () => {
    const directory = await mkdtemp(join(tmpdir(), "terminal-late-"));
    const ready = Promise.withResolvers<void>();
    const attached = Promise.withResolvers<void>();
    const closed = Promise.withResolvers<void>();
    const detach = vi.fn(async () => undefined);
    const write = vi.fn(async () => undefined);
    const server = new TerminalRuntimeSocketServer({
      socketPath: join(directory, "runtime.sock"),
      runtime: {
        resize: async () => ({ canonicalSize: { cols: 120, rows: 36 }, tabs: [{ id: ref.tabId, revision: 1 }] }),
        getSnapshot: async () => undefined,
        attach: async () => { await ready.promise; return { write, touch: () => undefined, detach }; },
      } as unknown as TerminalRuntimeControlApi,
    });
    await server.start();
    const client = new TerminalRuntimeSocketClient({ socketPath: join(directory, "runtime.sock") });
    const stream = client.attach({ ref, viewerId: "test", mode: "soft", size: { cols: 120, rows: 36 },
      onFrame: frame => { if (frame.type === "attached") attached.resolve(); },
      onClose: () => closed.resolve(), onError: () => closed.resolve(),
    });
    try {
      await attached.promise;
      stream.send({ type: "input", terminalRef: ref, data: "must not reach a late viewer" });
      stream.close();
      await closed.promise;
      ready.resolve();
      await vi.waitFor(() => expect(detach).toHaveBeenCalledTimes(1));
      expect(write).not.toHaveBeenCalled();
    } finally {
      ready.resolve(); stream.close(); await server.close(); await rm(directory, { recursive: true, force: true });
    }
  });

});
