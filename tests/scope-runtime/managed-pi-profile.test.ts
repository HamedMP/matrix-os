import { chmod, link, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createUnixSocketTempDir } from "../helpers/unix-socket-temp.js";
import { createSystemdScopeRuntimeLauncher } from "../../packages/scope-runtime/src/systemd-launcher.js";
import { createScopeRuntimeController } from "../../packages/scope-runtime/src/supervisor.js";
import { botSandboxRootsForHome, managedPiSandboxRootsForHome } from "../../packages/scope-runtime/src/sandbox.js";

const MANAGED_PROFILE = "scope-runtime-managed-pi-v1";
const RUNTIME = `runtime_${"2".repeat(32)}`;
const SCOPE = `scope_${"1".repeat(32)}`;
const REQUEST = "018f0ce5-7b4a-7f95-a7c8-acae0dc5c5d1";
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

async function setup() {
  const root = await createUnixSocketTempDir();
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const paths = {
    stateRoot: join(root, "state"), sdkDirectory: join(root, "sdk"), nativeDirectory: join(root, "native"),
    workerFile: join(root, "worker.js"), brokerSocket: join(root, "broker.sock"), nodeBinary: process.execPath,
    botRuntimeDirectory: join(root, "bot-runtime"), botSandboxRoots: botSandboxRootsForHome(home),
    managedPiSandboxRoots: managedPiSandboxRootsForHome(home),
  };
  const workspaces = [join(home, "agent-workspaces", "a".repeat(64), "chat_one"), join(home, "projects", "project_one"),
    join(home, "worktrees", "worktree_one"), join(home, "bots", "bot_one"), join(home, "system")];
  for (const path of [...workspaces, paths.sdkDirectory, paths.nativeDirectory, paths.botRuntimeDirectory]) await mkdir(path, { recursive: true });
  await writeFile(paths.workerFile, "export {};\n");
  await writeFile(join(paths.sdkDirectory, "sdk.mjs"), "export {};\n");
  await writeFile(join(paths.nativeDirectory, "claude"), "#!/bin/sh\nexit 0\n");
  await chmod(join(paths.nativeDirectory, "claude"), 0o755);
  await writeFile(join(paths.botRuntimeDirectory, "bot-worker.mjs"), "export {};\n");
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(paths.brokerSocket, resolve));
  cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const runCommand = vi.fn(async (command: string, args: readonly string[]) => {
    if (command === "/usr/bin/systemd-run") await writeFile(join(paths.stateRoot, "runtimes", "2".repeat(32), "ready"), `${RUNTIME}\n`);
    if (args[0] === "list-units") return { stdout: `matrix-scope-runtime-${"2".repeat(32)}.service loaded active running\n` };
    return { stdout: "active\n" };
  });
  const launcher = createSystemdScopeRuntimeLauncher({ ...paths, runCommand });
  return { root, home, paths, workspaces, runCommand, launcher };
}

const create = (hostPath: string, profileId = MANAGED_PROFILE, mode = "rw" as "rw" | "ro") => ({
  version: 1 as const, type: "runtime.create" as const, requestId: REQUEST, scopeHandle: SCOPE,
  profileId, workload: "bot_agent" as const, adapterId: "matrix-bot", harnessVersion: "1.0.0",
  sandbox: { version: 1 as const, scopeHandle: SCOPE, actorId: "owner_one", network: "broker_only" as const,
    worktree: { hostPath, mode, fingerprint: "a".repeat(64) } },
});

describe("managed Pi supervisor and actual launcher boundary", () => {
  it("discovers the managed profile only from configured roots, independently of recipe Bot support", async () => {
    const { launcher, paths, runCommand } = await setup();
    const controller = await createScopeRuntimeController({ launcher, executionGeneration: "7" });
    cleanup.push(() => controller.close());
    const request = { version: 1 as const, type: "capability.get" as const, requestId: REQUEST };
    const response = await controller.handle(request);
    expect(response).toMatchObject({ ok: true, profiles: [
      { profileId: "scope-runtime-chat-v1" },
      { profileId: "scope-runtime-bot-v1" },
      { profileId: MANAGED_PROFILE, adapters: [{ adapterId: "matrix-bot", harnessVersion: "1.0.0", workloads: ["bot_agent"] }] },
    ] });
    await expect(launcher.supportedAdapters?.("scope-runtime-forged-v1")).resolves.toEqual([]);

    const botOnlyLauncher = createSystemdScopeRuntimeLauncher({ ...paths, managedPiSandboxRoots: [], runCommand });
    const botOnly = await createScopeRuntimeController({ launcher: botOnlyLauncher, executionGeneration: "7" });
    cleanup.push(() => botOnly.close());
    const botOnlyResponse = await botOnly.handle(request);
    expect(botOnlyResponse).toMatchObject({ ok: true, profiles: [
      { profileId: "scope-runtime-chat-v1" }, { profileId: "scope-runtime-bot-v1" },
    ] });
    await expect(botOnly.handle(create(paths.managedPiSandboxRoots[0]!)))
      .resolves.toMatchObject({ ok: false, error: "profile_unavailable" });
    expect(runCommand.mock.calls.some(([command]) => command === "/usr/bin/systemd-run")).toBe(false);
  });

  it.each([0, 1, 2])("launches authorized root/project/worktree Chat %i with separate provenance and a single workspace bind", async (index) => {
    const { launcher, paths, workspaces, runCommand } = await setup();
    const controller = await createScopeRuntimeController({ launcher, executionGeneration: "7", createRuntimeHandle: () => RUNTIME });
    cleanup.push(() => controller.close());
    const request = create(workspaces[index]!, MANAGED_PROFILE, "ro");
    await expect(controller.handle(request)).resolves.toMatchObject({ ok: true, runtimeHandle: RUNTIME });
    const args = runCommand.mock.calls.find(([command]) => command === "/usr/bin/systemd-run")![1];
    expect(args.filter((arg) => arg.startsWith("--property=Bind") && arg.includes(":/workspace/project")))
      .toEqual([`--property=BindReadOnlyPaths=${workspaces[index]}:/workspace/project`]);
    expect(args).toContain("--property=PrivateNetwork=yes");
    expect(args).toContain("--property=ProtectHome=yes");
    expect(args).toContain("/opt/matrix/scope-sdk/bot-runtime/bot-worker.mjs");
    const provenance = JSON.parse(await readFile(join(paths.stateRoot, "runtimes", "2".repeat(32), "provenance.json"), "utf8"));
    expect(provenance).toMatchObject({ profileId: MANAGED_PROFILE, profileVersion: 1, workload: "bot_agent" });
    await expect(launcher.list()).resolves.toEqual([{ runtimeHandle: RUNTIME, executionGeneration: "7", profileId: MANAGED_PROFILE }]);
    // The same pinned worker command remains reachable through the distinct managed profile.
    launcher.runBot = vi.fn(async () => ({ version: 1 as const, ok: true as const, reply: { acknowledged: true } }));
    await expect(controller.handle({ version: 1, type: "runtime.bot", requestId: REQUEST, runtimeHandle: RUNTIME,
      executionGeneration: "7", command: { version: 1, kind: "bot.cancel", runId: "run_one" } })).resolves.toMatchObject({ ok: true });
  });

  it("retains recipe confinement and rejects managed Chat outside its roots", async () => {
    const { launcher, workspaces, runCommand } = await setup();
    const controller = await createScopeRuntimeController({ launcher, executionGeneration: "7", createRuntimeHandle: () => RUNTIME });
    cleanup.push(() => controller.close());
    for (const workspace of workspaces.slice(0, 3)) await expect(controller.handle(create(workspace, "scope-runtime-bot-v1"))).resolves.toMatchObject({ ok: false });
    for (const workspace of workspaces.slice(3)) await expect(controller.handle(create(workspace))).resolves.toMatchObject({ ok: false });
    const { sandbox: _sandbox, ...bare } = create(workspaces[0]!);
    await expect(controller.handle(bare)).resolves.toMatchObject({ ok: false, error: "invalid_request" });
    expect(runCommand.mock.calls.some(([command]) => command === "/usr/bin/systemd-run")).toBe(false);
  });

  it("rejects symlinks, hardlinks and swappable parents before systemd submission", async () => {
    const { launcher, home, root, workspaces, runCommand } = await setup();
    const controller = await createScopeRuntimeController({ launcher, executionGeneration: "7", createRuntimeHandle: () => RUNTIME });
    cleanup.push(() => controller.close());
    const linked = join(home, "projects", "linked");
    await symlink(workspaces[4]!, linked);
    await expect(controller.handle(create(linked))).resolves.toMatchObject({ ok: false });
    await writeFile(join(root, "secret"), "private");
    await link(join(root, "secret"), join(workspaces[1]!, "hardlinked"));
    await expect(controller.handle(create(workspaces[1]!))).resolves.toMatchObject({ ok: false });
    await chmod(join(home, "worktrees"), 0o777);
    await expect(controller.handle(create(workspaces[2]!))).resolves.toMatchObject({ ok: false });
    expect(runCommand.mock.calls.some(([command]) => command === "/usr/bin/systemd-run")).toBe(false);
  });

  it("does not expand a trusted root when the owner replaces that root with a symlink", async () => {
    const { launcher, home, root, runCommand } = await setup();
    const outside = join(root, "unrelated");
    await mkdir(outside);
    await rm(join(home, "projects"), { recursive: true });
    await symlink(outside, join(home, "projects"));
    const controller = await createScopeRuntimeController({ launcher, executionGeneration: "7", createRuntimeHandle: () => RUNTIME });
    cleanup.push(() => controller.close());
    await expect(controller.handle(create(outside))).resolves.toMatchObject({ ok: false });
    expect(runCommand.mock.calls.some(([command]) => command === "/usr/bin/systemd-run")).toBe(false);
  });
});
