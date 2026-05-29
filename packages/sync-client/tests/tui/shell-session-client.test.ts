import { describe, expect, it, vi } from "vitest";
import { createTuiShellSessionClient } from "../../src/cli/tui/shell-sessions.js";

describe("TUI shell session client", () => {
  it("normalizes shell sessions and preserves Matrix language over zellij internals", async () => {
    const shell = {
      listSessions: vi.fn(async () => [
        { name: "main", status: "active", cwd: "/home/matrix/project", updatedAt: "2026-05-28T12:00:00Z" },
        "scratch",
      ]),
    };
    const client = createTuiShellSessionClient(shell);

    await expect(client.list()).resolves.toEqual([
      expect.objectContaining({ id: "shell:main", kind: "shell", name: "main", status: "running" }),
      expect.objectContaining({ id: "shell:scratch", kind: "shell", name: "scratch", status: "unknown" }),
    ]);
  });

  it("normalizes tab and layout listing failures into safe TUI errors", async () => {
    const client = createTuiShellSessionClient({
      listTabs: vi.fn(async () => { throw new Error("postgres://secret"); }),
      listLayouts: vi.fn(async () => { throw new Error("/Users/private"); }),
    });

    await expect(client.listTabs("main")).rejects.toMatchObject({
      code: "request_failed",
      message: "Request failed",
    });
    await expect(client.listLayouts()).rejects.toMatchObject({
      code: "request_failed",
      message: "Request failed",
    });
  });

  it("delegates create, remove, tab, pane, and layout operations to the shell client", async () => {
    const shell = {
      createSession: vi.fn(async () => ({ ok: true })),
      deleteSession: vi.fn(async () => undefined),
      listTabs: vi.fn(async () => [{ index: 0, name: "editor" }]),
      listLayouts: vi.fn(async () => ["dev"]),
      splitPane: vi.fn(async () => ({ ok: true })),
      applyLayout: vi.fn(async () => ({ ok: true })),
    };
    const client = createTuiShellSessionClient(shell);

    await client.create({ name: "main", cwd: "/tmp", cmd: "pnpm dev" });
    await client.remove("main", { force: true });
    await expect(client.listTabs("main")).resolves.toEqual([{ index: 0, name: "editor" }]);
    await expect(client.listLayouts()).resolves.toEqual(["dev"]);
    await client.splitPane("main", { direction: "right", cmd: "claude" });
    await client.applyLayout("main", "dev");

    expect(shell.createSession).toHaveBeenCalledWith({ name: "main", cwd: "/tmp", cmd: "pnpm dev" });
    expect(shell.deleteSession).toHaveBeenCalledWith("main", { force: true });
    expect(shell.splitPane).toHaveBeenCalledWith("main", { direction: "right", cmd: "claude" });
  });
});
