import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TerminalRuntimeSocketClient } from "../../packages/terminal-runtime/src/socket-client.js";
import { TerminalRuntimeSocketServer } from "../../packages/terminal-runtime/src/socket-server.js";
import { encodeSocketFrame, SocketFrameDecoder } from "../../packages/terminal-runtime/src/socket-framing.js";

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

  it("serves bounded workspace control over an owner-only socket", async () => {
    const directory = await mkdtemp(join(tmpdir(), "matrix-terminal-socket-"));
    directories.push(directory);
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
    const server = new TerminalRuntimeSocketServer({
      socketPath,
      runtime: {
        listWorkspaces: async () => [workspace],
        ensureWorkspace: async () => workspace,
        createTab: async () => ({
          id: "tt_0123456789abcdef0123456789abcdef",
          workspaceId: workspace.id,
          name: "main",
          cwd: "",
          status: "running",
          revision: 1,
          order: 0,
          createdAt: workspace.createdAt,
          updatedAt: workspace.updatedAt,
        }),
        getSnapshot: async () => undefined,
      },
    });
    await server.start();
    const client = new TerminalRuntimeSocketClient({ socketPath });

    expect((await stat(socketPath)).mode & 0o777).toBe(0o600);
    expect(await client.listWorkspaces()).toEqual([workspace]);
    expect((await client.ensureWorkspace()).id).toBe(workspace.id);
    expect((await client.createTab(workspace.id, { name: "main", cwd: "" })).workspaceId).toBe(workspace.id);

    await server.close();
  });
});
