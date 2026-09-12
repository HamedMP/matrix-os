import { chmod, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TerminalRuntimeSocketClient } from "../../packages/terminal-runtime/src/socket-client.js";
import { TerminalRuntimeError } from "../../packages/terminal-runtime/src/errors.js";
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

  it("translates the live-tail sentinel before assigning output sequences", async () => {
    const directory = await mkdtemp(join(tmpdir(), "matrix-terminal-socket-live-tail-"));
    directories.push(directory);
    const socketPath = join(directory, "terminal-runtime.sock");
    const terminalRef = {
      workspaceId: "tws_0123456789abcdef0123456789abcdef",
      tabId: "tt_0123456789abcdef0123456789abcdef",
    };
    const tab = {
      id: terminalRef.tabId,
      workspaceId: terminalRef.workspaceId,
      name: "main",
      cwd: "",
      status: "running" as const,
      revision: 1,
      order: 0,
      createdAt: "2026-08-11T12:00:00.000Z",
      updatedAt: "2026-08-11T12:00:00.000Z",
    };
    const workspace = {
      id: terminalRef.workspaceId,
      scope: "main" as const,
      canonicalSize: { cols: 120, rows: 36 },
      status: "running" as const,
      revision: 1,
      createdAt: tab.createdAt,
      updatedAt: tab.updatedAt,
      tabs: [tab],
    };
    const snapshot = {
      schemaVersion: 1 as const,
      terminalRef,
      revision: 1,
      presentationRevision: 0,
      seq: 41,
      ansi: "checkpoint",
      viewport: [],
      scrollback: [],
      updatedAt: tab.updatedAt,
    };
    let emitOutput: ((data: Uint8Array) => void | Promise<void>) | undefined;
    const attachmentReady = Promise.withResolvers<void>();
    const server = new TerminalRuntimeSocketServer({
      socketPath,
      runtime: {
        listWorkspaces: async () => [workspace],
        ensureWorkspace: async () => workspace,
        createTab: async () => tab,
        getSnapshot: async () => snapshot,
        resize: async () => workspace,
        attach: async (_ref, input) => {
          emitOutput = input.send;
          attachmentReady.resolve();
          return {
            write: async () => undefined,
            touch: () => undefined,
            detach: async () => undefined,
          };
        },
        updateTabUiState: async () => tab,
      },
    });
    await server.start();
    const client = new TerminalRuntimeSocketClient({ socketPath });
    const frames: Array<{ type: string; seq?: number; nextSeq?: number }> = [];
    const outputsReady = Promise.withResolvers<void>();
    const stream = client.attach({
      ref: terminalRef,
      viewerId: "desktop-live-tail-test",
      fromSeq: Number.MAX_SAFE_INTEGER,
      mode: "soft",
      size: { cols: 120, rows: 36 },
      onFrame: (frame) => {
        frames.push(frame);
        if (frames.filter((candidate) => candidate.type === "output").length === 2) {
          outputsReady.resolve();
        }
      },
      onClose: () => undefined,
      onError: outputsReady.reject,
    });
    await attachmentReady.promise;

    await emitOutput?.(new TextEncoder().encode("first"));
    await emitOutput?.(new TextEncoder().encode("second"));
    await outputsReady.promise;

    expect(frames.find((frame) => frame.type === "attached")?.nextSeq).toBe(42);
    expect(frames.filter((frame) => frame.type === "output").map((frame) => frame.seq))
      .toEqual([42, 43]);
    stream.close();
    await server.close();
  });

  it("preserves binary terminal input bytes across the gateway-runtime socket", async () => {
    const directory = await mkdtemp(join(tmpdir(), "matrix-terminal-socket-binary-"));
    directories.push(directory);
    const socketPath = join(directory, "terminal-runtime.sock");
    const terminalRef = {
      workspaceId: "tws_0123456789abcdef0123456789abcdef",
      tabId: "tt_0123456789abcdef0123456789abcdef",
    };
    const tab = {
      id: terminalRef.tabId,
      workspaceId: terminalRef.workspaceId,
      name: "main",
      cwd: "",
      status: "running" as const,
      revision: 1,
      order: 0,
      createdAt: "2026-08-11T12:00:00.000Z",
      updatedAt: "2026-08-11T12:00:00.000Z",
    };
    const workspace = {
      id: terminalRef.workspaceId,
      scope: "main" as const,
      canonicalSize: { cols: 120, rows: 36 },
      status: "running" as const,
      revision: 1,
      createdAt: tab.createdAt,
      updatedAt: tab.updatedAt,
      tabs: [tab],
    };
    const received = Promise.withResolvers<Uint8Array>();
    const server = new TerminalRuntimeSocketServer({
      socketPath,
      runtime: {
        listWorkspaces: async () => [workspace],
        ensureWorkspace: async () => workspace,
        createTab: async () => tab,
        getSnapshot: async () => undefined,
        resize: async () => workspace,
        attach: async () => ({
          write: async (data) => { received.resolve(Uint8Array.from(data as Uint8Array)); },
          touch: () => undefined,
          detach: async () => undefined,
        }),
        updateTabUiState: async () => tab,
      },
    });
    await server.start();
    const client = new TerminalRuntimeSocketClient({ socketPath });
    const stream = client.attach({
      ref: terminalRef,
      viewerId: "desktop-binary-test",
      fromSeq: Number.MAX_SAFE_INTEGER,
      mode: "soft",
      size: { cols: 120, rows: 36 },
      onFrame: (frame) => {
        if (frame.type === "attached") {
          stream.send({ type: "binary", terminalRef, dataBase64: "G10xMDs/BxtcG1s8NjQ7MTU7NU2A/w==" });
        }
      },
      onClose: () => undefined,
      onError: received.reject,
    });

    await expect(received.promise).resolves.toEqual(
      Uint8Array.from([
        0x1b, 0x5d, 0x31, 0x30, 0x3b, 0x3f, 0x07, 0x1b, 0x5c,
        0x1b, 0x5b, 0x3c, 0x36, 0x34, 0x3b, 0x31, 0x35, 0x3b, 0x35, 0x4d,
        0x80, 0xff,
      ]),
    );
    stream.close();
    await server.close();
  });

  it("preserves typed domain failures across the socket boundary", async () => {
    const directory = await mkdtemp(join(tmpdir(), "matrix-terminal-socket-errors-"));
    directories.push(directory);
    const socketPath = join(directory, "terminal-runtime.sock");
    const deleteWorkspace = vi.fn(async (_workspaceId: string, input: { confirmTerminate: boolean }) => {
      if (!input.confirmTerminate) throw new TerminalRuntimeError("confirmation_required");
    });
    const server = new TerminalRuntimeSocketServer({
      socketPath,
      runtime: {
        listWorkspaces: async () => { throw new TerminalRuntimeError("not_found"); },
        ensureWorkspace: async () => { throw new TerminalRuntimeError("not_found"); },
        createTab: async () => { throw new TerminalRuntimeError("not_found"); },
        getSnapshot: async () => undefined,
        resize: async () => { throw new TerminalRuntimeError("not_found"); },
        attach: async () => { throw new TerminalRuntimeError("not_found"); },
        updateTabUiState: async () => { throw new TerminalRuntimeError("conflict"); },
        deleteWorkspace,
      },
    });
    await server.start();
    const client = new TerminalRuntimeSocketClient({ socketPath });

    await expect(client.listWorkspaces()).rejects.toMatchObject({
      name: "TerminalRuntimeError",
      code: "not_found",
      message: "Terminal operation failed",
    });
    await expect(client.deleteWorkspace(
      "tws_0123456789abcdef0123456789abcdef",
      { confirmTerminate: false },
    )).rejects.toMatchObject({
      name: "TerminalRuntimeError",
      code: "confirmation_required",
      message: "Terminal termination confirmation required",
    });
    expect(deleteWorkspace).toHaveBeenCalledWith(
      "tws_0123456789abcdef0123456789abcdef",
      expect.objectContaining({ confirmTerminate: false }),
    );

    await server.close();
  });
});
