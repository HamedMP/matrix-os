import { chmod, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TerminalRuntimeSocketClient } from "../../packages/terminal-runtime/src/socket-client.js";
import { TerminalRuntimeSocketServer } from "../../packages/terminal-runtime/src/socket-server.js";
import { encodeSocketFrame, SocketFrameDecoder } from "../../packages/terminal-runtime/src/socket-framing.js";
import {
  MAX_TERMINAL_RUNTIME_REQUEST_FRAME_BYTES,
  MAX_TERMINAL_RUNTIME_RESPONSE_FRAME_BYTES,
  MAX_TERMINAL_SNAPSHOT_BYTES,
} from "../../packages/terminal-runtime/src/limits.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("terminal runtime Unix socket API", () => {
  it("keeps legacy five MiB snapshots within a finite socket-frame bound", () => {
    const value = { type: "snapshot", ansi: "x".repeat(5 * 1024 * 1024) };
    const frame = encodeSocketFrame(value);
    expect(new SocketFrameDecoder().push(frame)).toEqual([value]);
  });

  it("keeps requests bounded while round-tripping a maximum control-heavy snapshot response", () => {
    const oversizedRequestHeader = Buffer.alloc(4);
    oversizedRequestHeader.writeUInt32BE(MAX_TERMINAL_RUNTIME_REQUEST_FRAME_BYTES + 1);
    expect(() => new SocketFrameDecoder().push(oversizedRequestHeader))
      .toThrow("Terminal runtime frame is too large");

    const ansi = "\u0001".repeat(5 * 1024 * 1024);
    const value = {
      version: 1,
      requestId: "req_0123456789abcdef0123456789abcdef",
      ok: true,
      result: { ansi, scrollback: [ansi] },
    };
    expect(MAX_TERMINAL_RUNTIME_RESPONSE_FRAME_BYTES).toBeGreaterThan(MAX_TERMINAL_SNAPSHOT_BYTES);
    const frame = encodeSocketFrame(value, MAX_TERMINAL_RUNTIME_RESPONSE_FRAME_BYTES);
    const decoded = new SocketFrameDecoder(MAX_TERMINAL_RUNTIME_RESPONSE_FRAME_BYTES).push(frame);
    expect(decoded).toHaveLength(1);
    expect((decoded[0] as typeof value).result.ansi).toHaveLength(ansi.length);
    expect((decoded[0] as typeof value).result.scrollback[0]).toHaveLength(ansi.length);
  });

  it("serves bounded workspace control over an owner-only socket", async () => {
    const directory = await mkdtemp(join(tmpdir(), "matrix-terminal-socket-"));
    directories.push(directory);
    await chmod(directory, 0o777);
    const socketPath = join(directory, "terminal-runtime.sock");
    const workspace = {
      id: "tws_0123456789abcdef0123456789abcdef",
      scope: "main" as const,
      canonicalSize: { cols: 120, rows: 36 },
      status: "running" as const,
      revision: 1,
      createdAt: "2026-08-11T12:00:00.000Z",
      updatedAt: "2026-08-11T12:00:00.000Z",
      tabs: [],
    };
    const tab = {
      id: "tt_0123456789abcdef0123456789abcdef",
      workspaceId: workspace.id,
      name: "main",
      cwd: "",
      status: "running" as const,
      revision: 1,
      order: 0,
      createdAt: workspace.createdAt,
      updatedAt: workspace.updatedAt,
    };
    const socketSnapshotAnsi = "\u0001".repeat(1024 * 1024);
    const socketSnapshot = {
      schemaVersion: 1 as const,
      terminalRef: { workspaceId: workspace.id, tabId: tab.id },
      revision: 1,
      presentationRevision: 7,
      seq: 1,
      ansi: socketSnapshotAnsi,
      viewport: [],
      scrollback: [socketSnapshotAnsi],
      updatedAt: workspace.updatedAt,
    };
    const paneAction = vi.fn(async () => undefined);
    const server = new TerminalRuntimeSocketServer({
      socketPath,
      runtime: {
        listWorkspaces: async () => [workspace],
        ensureWorkspace: async () => workspace,
        createTab: async () => tab,
        paneAction,
        getSnapshot: async () => socketSnapshot,
        resize: async () => ({ ...workspace, tabs: [tab] }),
        attach: async () => ({
          write: async () => undefined,
          touch: () => undefined,
          detach: async () => undefined,
        }),
        updateTabUiState: async (_ref, input) => ({
          ...tab,
          revision: 2,
          uiState: {
            placement: input.placement ?? "active",
            lastSeenSeq: input.lastSeenSeq ?? null,
            pinned: input.pinned ?? false,
          },
        }),
      },
    });
    const originalUmask = process.umask();
    const umaskSpy = vi.spyOn(process, "umask");
    await server.start();
    const client = new TerminalRuntimeSocketClient({ socketPath });

    expect(umaskSpy.mock.calls).toContainEqual([0o177]);
    expect(process.umask()).toBe(originalUmask);
    umaskSpy.mockRestore();
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await stat(socketPath)).mode & 0o777).toBe(0o600);
    expect(await client.listWorkspaces()).toEqual([workspace]);
    expect((await client.ensureWorkspace()).id).toBe(workspace.id);
    const created = await client.createTab(workspace.id, { name: "main", cwd: "" });
    expect(created.workspaceId).toBe(workspace.id);
    await client.paneAction(
      { workspaceId: workspace.id, tabId: created.id },
      { type: "focus", direction: "right" },
    );
    expect(paneAction).toHaveBeenCalledWith(
      { workspaceId: workspace.id, tabId: created.id },
      { type: "focus", direction: "right" },
    );
    const servedSnapshot = await client.getSnapshot({ workspaceId: workspace.id, tabId: created.id });
    expect((servedSnapshot as typeof socketSnapshot).ansi).toHaveLength(socketSnapshotAnsi.length);
    expect((servedSnapshot as typeof socketSnapshot).scrollback[0]).toHaveLength(socketSnapshotAnsi.length);
    const streamedSnapshot = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const stream = client.attach({
        ref: socketSnapshot.terminalRef,
        viewerId: "desktop-test",
        fromSeq: 0,
        mode: "soft",
        size: { cols: 120, rows: 36 },
        onFrame: (frame) => {
          if (frame.type === "snapshot") {
            stream.close();
            resolve(frame);
          }
        },
        onClose: () => undefined,
        onError: reject,
      });
    });
    expect(streamedSnapshot.presentationRevision).toBe(7);
    await expect(client.updateTabUiState(
      { workspaceId: workspace.id, tabId: created.id },
      { pinned: true, baseRevision: created.revision },
    )).resolves.toMatchObject({ uiState: { pinned: true } });

    await server.close();
  });
});
