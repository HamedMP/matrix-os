import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vitest";
import { TerminalRuntimeSocketClient } from "../../packages/terminal-runtime/src/socket-client.js";
import { TerminalRuntimeSocketServer } from "../../packages/terminal-runtime/src/socket-server.js";

it("coalesces slow native queries without blocking input and heartbeat frames", async () => {
  const directory = await mkdtemp(join(tmpdir(), "msc-socket-"));
  const ref = { workspaceId: `tws_${"a".repeat(32)}`, tabId: `tt_${"b".repeat(32)}` };
  const tab = { id: ref.tabId, workspaceId: ref.workspaceId, name: "main", cwd: "", status: "running" as const,
    revision: 1, order: 0, createdAt: "2026-09-18T00:00:00.000Z", updatedAt: "2026-09-18T00:00:00.000Z" };
  const workspace = { id: ref.workspaceId, scope: "main" as const, canonicalSize: { cols: 120, rows: 36 },
    status: "running" as const, revision: 1, createdAt: tab.createdAt, updatedAt: tab.updatedAt, tabs: [tab] };
  const pending = Promise.withResolvers<{ above: number; below: number; rows: number }>();
  const scrollState = vi.fn(() => pending.promise), write = vi.fn(async () => {}), touch = vi.fn();
  const server = new TerminalRuntimeSocketServer({ socketPath: join(directory, "runtime.sock"), runtime: {
    resize: async () => workspace, getSnapshot: async () => undefined,
    attach: async () => ({ write, touch, detach: async () => {} }), scrollState,
  } as unknown as ConstructorParameters<typeof TerminalRuntimeSocketServer>[0]["runtime"] });
  const frames: string[] = [];
  const closed = Promise.withResolvers<void>();
  const errors: Error[] = [];
  const client = new TerminalRuntimeSocketClient({ socketPath: join(directory, "runtime.sock") });
  await server.start();
  const stream = client.attach({ ref, viewerId: "scroll-test", fromSeq: 0, mode: "soft", size: workspace.canonicalSize,
    onFrame: (frame) => { frames.push(frame.type); }, onClose: closed.resolve, onError: (error) => errors.push(error) });
  try {
    await vi.waitFor(() => expect(frames).toContain("replay-end"));
    stream.send({ type: "scroll-query", terminalRef: ref });
    stream.send({ type: "scroll-query", terminalRef: ref });
    stream.send({ type: "input", terminalRef: ref, data: "hello" });
    stream.send({ type: "ping", terminalRef: ref });
    await vi.waitFor(() => expect(write).toHaveBeenCalledWith("hello"), { timeout: 500 });
    expect(touch).toHaveBeenCalledOnce(); expect(scrollState).toHaveBeenCalledOnce();
    expect(errors).toEqual([]);
    pending.resolve({ above: 20, below: 80, rows: 36 });
    await vi.waitFor(() => expect(frames).toContain("scroll-state"));
  } finally { pending.resolve({ above: 0, below: 0, rows: 36 }); stream.close(); await closed.promise; await server.close(); await rm(directory, { recursive: true, force: true }); }
});
