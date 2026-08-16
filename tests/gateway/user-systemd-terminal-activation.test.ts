import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import {
  TERMINAL_USER_SYSTEMD_ACTIVATION_MARKER,
  resolveUserSystemdTerminalActivation,
} from "../../packages/gateway/src/terminal-user-systemd-activation.js";

describe("user-systemd terminal activation", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function createAppDir(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "matrix-terminal-activation-"));
    roots.push(root);
    return root;
  }

  it("uses exact environment overrides for acceptance and emergency rollback", async () => {
    const appDir = await createAppDir();
    await writeFile(join(appDir, TERMINAL_USER_SYSTEMD_ACTIVATION_MARKER), "1\n");

    await expect(resolveUserSystemdTerminalActivation({ appDir, envValue: "1" })).resolves.toBe(true);
    await expect(resolveUserSystemdTerminalActivation({ appDir, envValue: "0" })).resolves.toBe(false);
    await expect(resolveUserSystemdTerminalActivation({ appDir, envValue: "true" })).resolves.toBe(false);
  });

  it("activates only from the exact regular bundle marker when no override exists", async () => {
    const appDir = await createAppDir();
    await writeFile(join(appDir, TERMINAL_USER_SYSTEMD_ACTIVATION_MARKER), "1\n");

    await expect(resolveUserSystemdTerminalActivation({ appDir })).resolves.toBe(true);
  });

  it("fails closed for missing, malformed, symlinked, and non-file markers", async () => {
    const missingDir = await createAppDir();
    await expect(resolveUserSystemdTerminalActivation({ appDir: missingDir })).resolves.toBe(false);

    const malformedDir = await createAppDir();
    await writeFile(join(malformedDir, TERMINAL_USER_SYSTEMD_ACTIVATION_MARKER), "enabled\n");
    await expect(resolveUserSystemdTerminalActivation({ appDir: malformedDir })).resolves.toBe(false);

    const symlinkDir = await createAppDir();
    await writeFile(join(symlinkDir, "target"), "1\n");
    await symlink("target", join(symlinkDir, TERMINAL_USER_SYSTEMD_ACTIVATION_MARKER));
    await expect(resolveUserSystemdTerminalActivation({ appDir: symlinkDir })).resolves.toBe(false);

    const directoryDir = await createAppDir();
    await mkdir(join(directoryDir, TERMINAL_USER_SYSTEMD_ACTIVATION_MARKER));
    await expect(resolveUserSystemdTerminalActivation({ appDir: directoryDir })).resolves.toBe(false);
  });
});
