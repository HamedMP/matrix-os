import { mkdir, mkdtemp, rm, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createTerminalNativeLauncher } from "../../../packages/gateway/src/terminal/native-launch.js";
const homes: string[] = [];
afterEach(async () => { for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true }); });
it.each(["claude", "codex", "hermes", "opencode", "pi"] as const)("keeps the owner's login-shell launch for %s on the hosted PTY", async harness => {
  const home = await mkdtemp("/tmp/terminal-builder-"); homes.push(home);
  const bin = join(home, ".local", "bin");
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, harness), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const run = vi.fn(async () => ({ stdout: "fixture-version", stderr: "" }));
  const launcher = createTerminalNativeLauncher({ homePath: home, runCommand: run });
  const launch = await launcher.build({ harness }, "");
  expect(launch).toMatchObject({
    command: "/usr/bin/env", args: ["sh", "-lc", expect.stringContaining(harness === "codex" ? "codex --no-alt-screen" : harness)],
    cwd: await realpath(home), env: { HOME: home }, inheritEnv: false, profile: "login-shell",
  });
  expect(run).not.toHaveBeenCalled();
  expect(JSON.stringify(launch)).not.toMatch(/TOKEN|SECRET|grant|capability|bypass|yolo|skip-permissions/);
});
it("missing Hermes stays visible in readiness and arbitrary executable/permission fields are rejected", async () => {
  const home = await mkdtemp("/tmp/terminal-builder-"); homes.push(home);
  const launcher = createTerminalNativeLauncher({ homePath: home, searchDirectories: [join(home, "empty")] });
  await expect(launcher.status("hermes")).resolves.toMatchObject({ installState: "missing" });
  await expect(launcher.build({ harness: "claude", command: "/bin/sh" } as never, "")).rejects.toThrow();
});

it("retains owner directories whose names begin with two dots", async () => {
  const home = await mkdtemp("/tmp/terminal-builder-");
  homes.push(home);
  const cwd = join(home, "..scratch");
  await mkdir(cwd);
  const launcher = createTerminalNativeLauncher({ homePath: home });
  const actualCwd = await realpath(cwd);
  await expect(launcher.build({ harness: "claude" }, "..scratch")).resolves.toMatchObject({ cwd: actualCwd });
});

it("rejects a cwd outside the owner home even through a symlink", async () => {
  const home = await mkdtemp("/tmp/terminal-builder-");
  const external = await mkdtemp("/tmp/terminal-external-");
  homes.push(home, external);
  await symlink(external, join(home, "escape"), "dir");
  const launcher = createTerminalNativeLauncher({ homePath: home });
  await expect(launcher.build({ harness: "claude" }, "escape")).rejects.toThrow("Terminal launch unavailable");
  await expect(launcher.build({ harness: "claude" }, "..")).rejects.toThrow("Terminal launch unavailable");
});
