import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertTerminalRuntimeDirectory,
  createTerminalRuntimeEnvironment,
} from "../../packages/terminal-runtime/src/runtime-environment.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("terminal owner runtime environment", () => {
  it("builds one explicit Zellij and user-systemd socket environment", () => {
    expect(createTerminalRuntimeEnvironment({
      homePath: "/home/matrix/home",
      uid: 999,
      inheritedEnv: {
        PATH: "/usr/bin",
        ZELLIJ: "nested",
        ZELLIJ_SESSION_NAME: "wrong",
        ZELLIJ_PANE_ID: "7",
        XDG_RUNTIME_DIR: "/wrong",
      },
    })).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/matrix/home",
      MATRIX_HOME: "/home/matrix/home",
      ZELLIJ_CONFIG_DIR: "/home/matrix/home/system/zellij",
      XDG_RUNTIME_DIR: "/run/user/999",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/999/bus",
    });
  });

  it("rejects a runtime directory not owned by the runtime uid", async () => {
    const root = await mkdtemp(join(tmpdir(), "matrix-runtime-env-"));
    roots.push(root);
    const runtimeDir = join(root, "runtime");
    await mkdir(runtimeDir);

    await expect(assertTerminalRuntimeDirectory(runtimeDir, process.getuid!() + 1))
      .rejects.toThrow("terminal_runtime_directory_unavailable");
  });

  it("accepts only a real runtime directory and rejects a symlink", async () => {
    const root = await mkdtemp(join(tmpdir(), "matrix-runtime-env-symlink-"));
    roots.push(root);
    const runtimeDir = join(root, "runtime");
    const linkedRuntimeDir = join(root, "linked-runtime");
    await mkdir(runtimeDir);
    await symlink(runtimeDir, linkedRuntimeDir);

    await expect(assertTerminalRuntimeDirectory(runtimeDir, process.getuid!()))
      .resolves.toBeUndefined();
    await expect(assertTerminalRuntimeDirectory(linkedRuntimeDir, process.getuid!()))
      .rejects.toThrow("terminal_runtime_directory_unavailable");
  });
});
