import { createUnixSocketTempDir } from "../helpers/unix-socket-temp.js";
import { lstat, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildBotSystemdRunArgs,
  createSystemdScopeRuntimeLauncher,
  type ScopeRuntimeCommandRunner,
} from "../../packages/scope-runtime/src/systemd-launcher.js";
import {
  SCOPE_RUNTIME_BOT_PROFILE_DIGEST,
  SCOPE_RUNTIME_BOT_PROFILE_ID,
  SCOPE_RUNTIME_BOT_PROFILE_VERSION,
} from "../../packages/scope-runtime/src/bot-profile.js";
import type { ScopeRuntimeSandboxManifest } from "../../packages/scope-runtime/src/protocol.js";

const RUNTIME_HANDLE = "runtime_22222222222222222222222222222222";
const SCOPE_HANDLE = "scope_11111111111111111111111111111111";
const SUFFIX = "22222222222222222222222222222222";
const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.allSettled(cleanup.splice(0).map((remove) => remove()));
});

async function fixture() {
  const root = await createUnixSocketTempDir();
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const botRuntimeDirectory = join(root, "bot-runtime");
  const brokerSocket = join(root, "broker.sock");
  const sdkDirectory = join(root, "sdk");
  const nativeDirectory = join(root, "native");
  for (const directory of [join(home, "bots", "bot_abcdef12"), join(home, "projects", "p1"), botRuntimeDirectory, sdkDirectory, nativeDirectory]) {
    await mkdir(directory, { recursive: true, mode: 0o755 });
  }
  await writeFile(join(botRuntimeDirectory, "bot-worker.mjs"), "export {};\n");
  const broker: Server = createServer();
  await new Promise<void>((resolve, reject) => {
    broker.once("error", reject);
    broker.listen(brokerSocket, resolve);
  });
  cleanup.push(() => new Promise<void>((resolve) => broker.close(() => resolve())));
  return {
    root,
    home,
    paths: {
      stateRoot: join(root, "state"),
      sdkDirectory,
      nativeDirectory,
      workerFile: join(root, "worker.js"),
      brokerSocket,
      nodeBinary: process.execPath,
      botRuntimeDirectory,
      sandboxRoots: [join(home, "projects")],
      botSandboxRoots: [join(home, "bots")],
    },
  };
}

function manifestFor(hostPath: string): ScopeRuntimeSandboxManifest {
  return {
    version: 1,
    scopeHandle: SCOPE_HANDLE,
    actorId: "bot_abcdef12",
    worktree: { hostPath, mode: "rw", fingerprint: "a".repeat(64) },
    network: "broker_only",
  };
}

const botLaunch = (hostPath: string) => ({
  runtimeHandle: RUNTIME_HANDLE,
  scopeHandle: SCOPE_HANDLE,
  profileId: SCOPE_RUNTIME_BOT_PROFILE_ID,
  workload: "bot_agent" as const,
  adapterId: "matrix-bot",
  harnessVersion: "0.86.1",
  executionGeneration: "7",
  sandbox: manifestFor(hostPath),
});

function readyRunner(stateRoot: string, calls: Array<{ command: string; args: readonly string[] }> = []): ScopeRuntimeCommandRunner {
  return vi.fn(async (command, args) => {
    calls.push({ command, args });
    if (command === "/usr/bin/systemd-run") {
      await writeFile(join(stateRoot, "runtimes", SUFFIX, "ready"), `${RUNTIME_HANDLE}\n`, { mode: 0o600 });
    }
    return { stdout: "active\n" };
  });
}

describe("scope runtime systemd launcher bot profile", () => {
  it("builds the bot unit from the bot profile with a mandatory sandbox", () => {
    const paths = {
      scopeRoot: "/var/lib/matrix-scope-runtime/runtimes/222/root",
      botRuntimeDirectory: "/opt/matrix/app/packages/bot-runtime/dist",
      brokerSocket: "/run/matrix-scope-runtime/broker.sock",
      readinessFile: "/var/lib/matrix-scope-runtime/runtimes/222/ready",
      commandDirectory: "/var/lib/matrix-scope-runtime/runtimes/222/command",
      nodeBinary: "/opt/matrix/runtime/node/bin/node",
    };
    const launch = botLaunch("/home/matrix/home/bots/bot_abcdef12");
    const args = buildBotSystemdRunArgs(launch, paths, { sandboxProperties: ["PrivateNetwork=yes"] });
    expect(args).toContain("--property=RuntimeMaxSec=900");
    expect(args).toContain("--property=BindReadOnlyPaths=/opt/matrix/app/packages/bot-runtime/dist:/opt/matrix/scope-sdk/bot-runtime");
    expect(args.join("\n")).not.toContain("scope-sdk/sdk");
    expect(args.slice(args.indexOf("--") + 1)).toEqual([
      "/usr/bin/env", "-i", "HOME=/workspace", "PATH=/opt/matrix/runtime/node/bin", "MATRIX_SCOPE_RUNTIME=1",
      "/opt/matrix/runtime/node/bin/node", "/opt/matrix/scope-sdk/bot-runtime/bot-worker.mjs",
      RUNTIME_HANDLE, SCOPE_HANDLE, "bot_agent", "matrix-bot", "0.86.1", "7",
    ]);
    expect(() => buildBotSystemdRunArgs(launch, paths, { sandboxProperties: [] })).toThrow("sandbox");
    expect(() => buildBotSystemdRunArgs({ ...launch, adapterId: "claude-code", harnessVersion: "2.1.240" }, paths, {
      sandboxProperties: ["PrivateNetwork=yes"],
    })).toThrow("Unsupported");
    expect(() => buildBotSystemdRunArgs({ ...launch, profileId: "scope-runtime-chat-v1" }, paths, {
      sandboxProperties: ["PrivateNetwork=yes"],
    })).toThrow("Unsupported");
  });

  it("advertises the bot adapter only when the bundled worker and bot roots are present", async () => {
    const { paths, root } = await fixture();
    const runCommand = vi.fn(async () => ({ stdout: "" }));
    await expect(createSystemdScopeRuntimeLauncher({ ...paths, runCommand }).supportedAdapters?.(SCOPE_RUNTIME_BOT_PROFILE_ID))
      .resolves.toEqual([{ adapterId: "matrix-bot", harnessVersion: "0.86.1", workloads: ["bot_agent"] }]);
    await expect(createSystemdScopeRuntimeLauncher({ ...paths, botSandboxRoots: [], runCommand })
      .supportedAdapters?.(SCOPE_RUNTIME_BOT_PROFILE_ID)).resolves.toEqual([]);
    const { botRuntimeDirectory: _unused, ...withoutBundle } = paths;
    await expect(createSystemdScopeRuntimeLauncher({ ...withoutBundle, runCommand })
      .supportedAdapters?.(SCOPE_RUNTIME_BOT_PROFILE_ID)).resolves.toEqual([]);
    // An entry that is a symbolic link is refused.
    await rm(join(paths.botRuntimeDirectory, "bot-worker.mjs"));
    await writeFile(join(root, "elsewhere.mjs"), "export {};\n");
    await symlink(join(root, "elsewhere.mjs"), join(paths.botRuntimeDirectory, "bot-worker.mjs"));
    await expect(createSystemdScopeRuntimeLauncher({ ...paths, runCommand }).supportedAdapters?.(SCOPE_RUNTIME_BOT_PROFILE_ID))
      .resolves.toEqual([]);
    await expect(createSystemdScopeRuntimeLauncher({ ...paths, runCommand }).supportedAdapters?.("scope-runtime-other-v1"))
      .resolves.toEqual([]);
  });

  it("launches a bot inside its workspace under the bot root with bot provenance", async () => {
    const { paths, home } = await fixture();
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const launcher = createSystemdScopeRuntimeLauncher({ ...paths, runCommand: readyRunner(paths.stateRoot, calls) });
    const workspace = join(home, "bots", "bot_abcdef12");

    await expect(launcher.start(botLaunch(workspace))).resolves.toBeUndefined();
    const submitted = calls.find((call) => call.command === "/usr/bin/systemd-run")!.args;
    expect(submitted).toContain(`--property=BindPaths=${workspace}:/workspace/project`);
    expect(submitted).toContain(`--property=BindReadOnlyPaths=${paths.botRuntimeDirectory}:/opt/matrix/scope-sdk/bot-runtime`);
    const runtimeRoot = join(paths.stateRoot, "runtimes", SUFFIX);
    expect(JSON.parse(await readFile(join(runtimeRoot, "provenance.json"), "utf8"))).toMatchObject({
      profileId: SCOPE_RUNTIME_BOT_PROFILE_ID,
      profileVersion: SCOPE_RUNTIME_BOT_PROFILE_VERSION,
      profileDigest: SCOPE_RUNTIME_BOT_PROFILE_DIGEST,
      workload: "bot_agent",
      adapterId: "matrix-bot",
    });
    expect((await stat(join(runtimeRoot, "root/opt/matrix/scope-sdk/bot-runtime"))).isDirectory()).toBe(true);
    await expect(lstat(join(runtimeRoot, "root/opt/matrix/scope-runtime/worker.mjs"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses bot workspaces outside the bot root or reached through a symbolic link", async () => {
    const { paths, home, root } = await fixture();
    const runCommand = readyRunner(paths.stateRoot);
    const launcher = createSystemdScopeRuntimeLauncher({ ...paths, runCommand });
    await expect(launcher.start(botLaunch(join(home, "projects", "p1")))).rejects.toThrow("allowed roots");
    await mkdir(join(root, "outside"));
    await symlink(join(root, "outside"), join(home, "bots", "bot_linked123"));
    await expect(launcher.start(botLaunch(join(home, "bots", "bot_linked123")))).rejects.toThrow("symbolic link");
    expect(vi.mocked(runCommand).mock.calls.some(([command]) => command === "/usr/bin/systemd-run")).toBe(false);
  });

  it("reconciles bot units by provenance and reports running units without cleaning up", async () => {
    const { paths } = await fixture();
    const runtimeRoot = join(paths.stateRoot, "runtimes", SUFFIX);
    await mkdir(runtimeRoot, { recursive: true });
    await writeFile(join(runtimeRoot, "ready"), `${RUNTIME_HANDLE}\n`);
    await writeFile(join(runtimeRoot, "provenance.json"), JSON.stringify({
      version: 1, runtimeHandle: RUNTIME_HANDLE, profileId: SCOPE_RUNTIME_BOT_PROFILE_ID,
      profileVersion: SCOPE_RUNTIME_BOT_PROFILE_VERSION, profileDigest: SCOPE_RUNTIME_BOT_PROFILE_DIGEST,
      workload: "bot_agent", adapterId: "matrix-bot", harnessVersion: "0.86.1", executionGeneration: "7",
    }));
    const calls: Array<readonly string[]> = [];
    const runCommand: ScopeRuntimeCommandRunner = vi.fn(async (_command, args) => {
      calls.push(args);
      if (args[0] === "list-units") return { stdout: `matrix-scope-runtime-${SUFFIX}.service loaded active running\n` };
      return { stdout: "" };
    });
    const launcher = createSystemdScopeRuntimeLauncher({ ...paths, runCommand });

    await expect(launcher.active?.()).resolves.toEqual(new Set([RUNTIME_HANDLE]));
    expect(calls.at(-1)).toContain("--state=active");
    expect(calls.some((args) => args[0] === "stop" || args[0] === "reset-failed")).toBe(false);
    await expect(launcher.list()).resolves.toEqual([{
      runtimeHandle: RUNTIME_HANDLE, executionGeneration: "7", profileId: SCOPE_RUNTIME_BOT_PROFILE_ID,
    }]);
  });

  it("relays bot commands over the worker socket and rejects malformed replies", async () => {
    const { paths } = await fixture();
    const commandDirectory = join(paths.stateRoot, "runtimes", SUFFIX, "command");
    await mkdir(commandDirectory, { recursive: true });
    const replies = [`${JSON.stringify({ version: 1, ok: true, reply: { acknowledged: true } })}\n`, "not json\n"];
    const frames: unknown[] = [];
    const worker = createServer({ allowHalfOpen: true }, (socket) => {
      let input = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk) => { input += chunk; });
      socket.once("end", () => {
        frames.push(JSON.parse(input));
        socket.end(replies.shift());
      });
    });
    await new Promise<void>((resolve, reject) => {
      worker.once("error", reject);
      worker.listen(join(commandDirectory, "worker.sock"), resolve);
    });
    cleanup.push(() => new Promise<void>((resolve) => worker.close(() => resolve())));
    const launcher = createSystemdScopeRuntimeLauncher({ ...paths, runCommand: vi.fn(async () => ({ stdout: "" })) });
    const command = { version: 1 as const, kind: "bot.steer" as const, runId: "run_one", text: "shorter" };

    await expect(launcher.runBot?.({ runtimeHandle: RUNTIME_HANDLE, executionGeneration: "7", command }))
      .resolves.toEqual({ version: 1, ok: true, reply: { acknowledged: true } });
    expect(frames[0]).toEqual({ version: 1, type: "runtime.bot", runtimeHandle: RUNTIME_HANDLE, executionGeneration: "7", command });
    await expect(launcher.runBot?.({ runtimeHandle: RUNTIME_HANDLE, executionGeneration: "7", command }))
      .rejects.toThrow("invalid");
  });
});
