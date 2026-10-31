import { mkdtemp, mkdir, chmod, rm, writeFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createTerminalNativeLauncher } from "../../../packages/gateway/src/terminal/native-launch.js";
const homes: string[] = [];
afterEach(async () => { for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true }); });
it.each(["claude", "codex", "hermes", "opencode", "pi"] as const)("uses the fixed native %s executable and preserves native permission configuration", async harness => {
  const home = await mkdtemp("/tmp/terminal-builder-"); homes.push(home); const bin = join(home, ".local", "bin"); await mkdir(bin, { recursive: true });
  const executable = join(bin, harness); await writeFile(executable, "#!/bin/sh\nexit 0\n"); await chmod(executable, 0o700);
  const run = vi.fn(async () => ({ stdout: "fixture-version", stderr: "" }));
  const launcher = createTerminalNativeLauncher({ homePath: home, runCommand: run });
  const launch = await launcher.build({ harness }, "");
  expect(launch).toMatchObject({ command: await realpath(executable), cwd: await realpath(home), env: { HOME: home }, inheritEnv: false });
  expect(launch.args).toEqual(harness === "codex" ? ["--no-alt-screen"] : []);
  expect(run).toHaveBeenCalledWith(await realpath(executable), ["--version"], expect.objectContaining({ timeout: 5000, env: expect.objectContaining({ HOME: home }) }));
  expect(JSON.stringify(launch)).not.toMatch(/TOKEN|SECRET|grant|capability|bypass|yolo|skip-permissions/);
});
it("missing Hermes is explicitly unavailable and arbitrary executable/permission fields are rejected", async () => {
  const home = await mkdtemp("/tmp/terminal-builder-"); homes.push(home);
  const launcher = createTerminalNativeLauncher({ homePath: home, searchDirectories: [join(home, "empty")] });
  await expect(launcher.build({ harness: "hermes" }, "")).rejects.toThrow();
  await expect(launcher.build({ harness: "claude", command: "/bin/sh" } as never, "")).rejects.toThrow();
});
