import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createUserSystemdTerminalRuntime,
  loadInstalledTerminalRuntimeGeneration,
  type UserSystemdCommandRunner,
} from "../../packages/gateway/src/shell/user-systemd-terminal-runtime.js";

const RUNTIME_ID = "rt_0123456789abcdef0123456789abcdef";
const OTHER_RUNTIME_ID = "rt_fedcba9876543210fedcba9876543210";
const GENERATION = "gen_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

describe("user-systemd terminal runtime", () => {
  let homePath: string;
  let cwd: string;
  let layoutPath: string;

  beforeEach(async () => {
    homePath = await mkdtemp(join(tmpdir(), "matrix-user-systemd-runtime-"));
    cwd = join(homePath, "projects", "demo");
    layoutPath = join(homePath, "system", "zellij", "layouts", `${RUNTIME_ID}.kdl`);
    await mkdir(cwd, { recursive: true });
    await mkdir(join(homePath, "system", "zellij", "layouts"), { recursive: true });
    await writeFile(layoutPath, "layout { pane }\n");
  });

  afterEach(async () => {
    await rm(homePath, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("loads only an exact generation marker from the installed app", async () => {
    const appDir = join(homePath, "installed-app");
    await mkdir(appDir);
    await writeFile(join(appDir, "TERMINAL_RUNTIME_GENERATION"), `${GENERATION}\n`);

    await expect(loadInstalledTerminalRuntimeGeneration(appDir)).resolves.toBe(GENERATION);
    await writeFile(join(appDir, "TERMINAL_RUNTIME_GENERATION"), "../../unsafe\n");
    await expect(loadInstalledTerminalRuntimeGeneration(appDir)).rejects.toThrow("Terminal runtime unavailable");
  });

  it("creates an owner descriptor atomically and starts only the derived user unit", async () => {
    const runCommand = vi.fn<UserSystemdCommandRunner>(async () => ({ stdout: "", stderr: "" }));
    const runtime = createUserSystemdTerminalRuntime({
      homePath,
      uid: 1001,
      generation: GENERATION,
      runCommand,
      readinessProbe: vi.fn(async () => true),
      now: () => "2026-07-31T12:00:00.000Z",
    });

    const created = await runtime.create({
      runtimeId: RUNTIME_ID,
      scope: "terminal",
      kind: "shell",
      displayName: "Main shell",
      cwd,
      layoutPath,
    });

    expect(created).toMatchObject({
      runtimeId: RUNTIME_ID,
      scope: "terminal",
      sessionName: `matrix-${RUNTIME_ID}`,
      generation: GENERATION,
      lifecycle: "running",
    });
    const descriptorPath = join(homePath, "system", "terminal-runtimes", `${RUNTIME_ID}.json`);
    expect(JSON.parse(await readFile(descriptorPath, "utf8"))).toEqual({
      version: 1,
      runtimeId: RUNTIME_ID,
      sessionName: `matrix-${RUNTIME_ID}`,
      scope: "terminal",
      kind: "shell",
      displayName: "Main shell",
      cwd,
      layoutPath,
      generation: GENERATION,
      createdAt: "2026-07-31T12:00:00.000Z",
    });
    expect(runCommand).toHaveBeenCalledWith(
      "systemctl",
      ["--user", "start", `matrix-zellij@${RUNTIME_ID}.service`],
      expect.objectContaining({
        timeoutMs: 10_000,
        env: expect.objectContaining({
          XDG_RUNTIME_DIR: "/run/user/1001",
          DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1001/bus",
        }),
      }),
    );
  });

  it("serializes descriptor creation with generation garbage collection across processes", async () => {
    const descriptorRoot = join(homePath, "system", "terminal-runtimes");
    await mkdir(descriptorRoot, { recursive: true });
    const helperPath = join(process.cwd(), "distro/customer-vps/host-bin/matrix-terminal-generation-gc.py");
    const holder = spawn("python3", [helperPath, "--lock", descriptorRoot], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    await new Promise<void>((resolve, reject) => {
      holder.once("error", reject);
      holder.stdout.once("data", (chunk) => {
        if (chunk.toString() === "locked\n") resolve();
        else reject(new Error("generation lock holder did not become ready"));
      });
    });
    const runCommand = vi.fn<UserSystemdCommandRunner>(async () => ({ stdout: "", stderr: "" }));
    const runtime = createUserSystemdTerminalRuntime({
      homePath,
      uid: 1001,
      generation: GENERATION,
      generationLockHelperPath: helperPath,
      runCommand,
      readinessProbe: vi.fn(async () => true),
      now: () => "2026-07-31T12:00:00.000Z",
    });

    let settled = false;
    const creating = runtime.create({
      runtimeId: RUNTIME_ID,
      scope: "terminal",
      kind: "shell",
      displayName: "Main shell",
      cwd,
      layoutPath,
    }).finally(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(settled).toBe(false);

    holder.stdin.end();
    await expect(creating).resolves.toMatchObject({ runtimeId: RUNTIME_ID });
  });

  it("rejects unsafe IDs and paths before writing state or invoking systemd", async () => {
    const runCommand = vi.fn<UserSystemdCommandRunner>();
    const runtime = createUserSystemdTerminalRuntime({
      homePath,
      uid: 1001,
      generation: GENERATION,
      runCommand,
    });

    await expect(runtime.create({
      runtimeId: "../../matrix-gateway",
      scope: "terminal",
      kind: "shell",
      displayName: "bad",
      cwd,
      layoutPath,
    })).rejects.toThrow("Invalid terminal runtime request");
    await expect(runtime.create({
      runtimeId: RUNTIME_ID,
      scope: "workspace",
      kind: "agent",
      displayName: "bad",
      cwd: "/etc",
      layoutPath,
    })).rejects.toThrow("Invalid terminal runtime request");
    await expect(runtime.create({
      runtimeId: RUNTIME_ID,
      scope: "workspace",
      kind: "agent",
      displayName: "bad",
      cwd,
      layoutPath: "/tmp/attacker.kdl",
    })).rejects.toThrow("Invalid terminal runtime request");
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("fails closed when the descriptor directory is an owner-created symlink", async () => {
    const outside = await mkdtemp(join(tmpdir(), "matrix-runtime-outside-"));
    await mkdir(join(homePath, "system"), { recursive: true });
    await symlink(outside, join(homePath, "system", "terminal-runtimes"));
    const runCommand = vi.fn<UserSystemdCommandRunner>();
    const runtime = createUserSystemdTerminalRuntime({
      homePath,
      uid: 1001,
      generation: GENERATION,
      runCommand,
    });

    await expect(runtime.create({
      runtimeId: RUNTIME_ID,
      scope: "terminal",
      kind: "shell",
      displayName: "Main",
      cwd,
      layoutPath,
    })).rejects.toThrow("Invalid terminal runtime request");
    expect(runCommand).not.toHaveBeenCalled();
    await rm(outside, { recursive: true, force: true });
  });

  it("makes same-descriptor create retries idempotent but rejects runtime-ID reuse", async () => {
    const runCommand = vi.fn<UserSystemdCommandRunner>(async () => ({ stdout: "", stderr: "" }));
    const runtime = createUserSystemdTerminalRuntime({
      homePath,
      uid: 1001,
      generation: GENERATION,
      runCommand,
      readinessProbe: vi.fn(async () => true),
      now: () => "2026-07-31T12:00:00.000Z",
    });
    const input = {
      runtimeId: RUNTIME_ID,
      scope: "workspace" as const,
      kind: "agent" as const,
      displayName: "Codex",
      cwd,
      layoutPath,
    };

    await runtime.create(input);
    await expect(runtime.create(input)).resolves.toMatchObject({ lifecycle: "running" });
    await expect(runtime.create({ ...input, displayName: "Claude" })).rejects.toThrow(
      "Terminal runtime identity already exists",
    );
    expect(runCommand).toHaveBeenCalledTimes(2);
  });

  it("rejects a second runtime identity in the same scope with the same display name", async () => {
    const runCommand = vi.fn<UserSystemdCommandRunner>(async () => ({ stdout: "", stderr: "" }));
    const runtime = createUserSystemdTerminalRuntime({
      homePath,
      uid: 1001,
      generation: GENERATION,
      runCommand,
      readinessProbe: vi.fn(async () => true),
      now: () => "2026-07-31T12:00:00.000Z",
    });
    const input = { scope: "terminal" as const, kind: "shell" as const, displayName: "Main", cwd, layoutPath };

    await runtime.create({ ...input, runtimeId: RUNTIME_ID });
    await expect(runtime.create({ ...input, runtimeId: OTHER_RUNTIME_ID })).rejects.toThrow(
      "Terminal runtime identity already exists",
    );

    await expect(readFile(
      join(homePath, "system", "terminal-runtimes", `${OTHER_RUNTIME_ID}.json`),
      "utf8",
    )).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reconciles a durable inactive descriptor through the exact immutable unit", async () => {
    const runCommand = vi.fn<UserSystemdCommandRunner>(async () => ({ stdout: "", stderr: "" }));
    const runtime = createUserSystemdTerminalRuntime({
      homePath,
      uid: 1001,
      generation: GENERATION,
      runCommand,
      readinessProbe: vi.fn(async () => true),
      now: () => "2026-07-31T12:00:00.000Z",
    });
    await runtime.create({
      runtimeId: RUNTIME_ID,
      scope: "terminal",
      kind: "shell",
      displayName: "Main",
      cwd,
      layoutPath,
    });
    runCommand.mockClear();

    await expect(runtime.start(RUNTIME_ID)).resolves.toMatchObject({ lifecycle: "running" });
    expect(runCommand).toHaveBeenCalledWith(
      "systemctl",
      ["--user", "start", `matrix-zellij@${RUNTIME_ID}.service`],
      expect.any(Object),
    );
  });

  it("keeps the durable descriptor when start fails so a retry can reconcile it", async () => {
    const runCommand = vi.fn<UserSystemdCommandRunner>(async () => {
      throw new Error("dbus secret /run/user/1001/bus");
    });
    const runtime = createUserSystemdTerminalRuntime({
      homePath,
      uid: 1001,
      generation: GENERATION,
      runCommand,
    });

    await expect(runtime.create({
      runtimeId: RUNTIME_ID,
      scope: "terminal",
      kind: "shell",
      displayName: "Main",
      cwd,
      layoutPath,
    })).rejects.toThrow("Terminal runtime unavailable");
    await expect(readFile(
      join(homePath, "system", "terminal-runtimes", `${RUNTIME_ID}.json`),
      "utf8",
    )).resolves.toContain(RUNTIME_ID);
  });

  it("removes the descriptor only after systemd confirms the exact unit stopped", async () => {
    const runCommand = vi.fn<UserSystemdCommandRunner>(async () => ({ stdout: "", stderr: "" }));
    const runtime = createUserSystemdTerminalRuntime({
      homePath,
      uid: 1001,
      generation: GENERATION,
      runCommand,
      readinessProbe: vi.fn(async () => true),
      now: () => "2026-07-31T12:00:00.000Z",
    });
    await runtime.create({ runtimeId: RUNTIME_ID, scope: "terminal", kind: "shell", displayName: "Main", cwd, layoutPath });

    await expect(runtime.delete(RUNTIME_ID)).resolves.toEqual({ ok: true });

    expect(runCommand).toHaveBeenLastCalledWith(
      "systemctl",
      ["--user", "stop", `matrix-zellij@${RUNTIME_ID}.service`],
      expect.any(Object),
    );
    await expect(readFile(
      join(homePath, "system", "terminal-runtimes", `${RUNTIME_ID}.json`),
      "utf8",
    )).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retains cleanup metadata when a referenced launch snapshot cannot be removed", async () => {
    const environmentPath = join(homePath, "system", "terminal-runtimes", "env", `${RUNTIME_ID}-0123456789abcdef.json`);
    await mkdir(join(homePath, "system", "terminal-runtimes", "env"), { recursive: true });
    await writeFile(environmentPath, "{}\n", { mode: 0o600 });
    const runCommand = vi.fn<UserSystemdCommandRunner>(async () => ({ stdout: "", stderr: "" }));
    const runtime = createUserSystemdTerminalRuntime({
      homePath,
      uid: 1001,
      generation: GENERATION,
      runCommand,
      readinessProbe: vi.fn(async () => true),
      now: () => "2026-07-31T12:00:00.000Z",
      removePath: vi.fn(async (path: string) => {
        if (path === environmentPath) throw new Error("simulated cleanup failure");
        await rm(path, { force: true });
      }),
    });
    await runtime.create({
      runtimeId: RUNTIME_ID,
      scope: "terminal",
      kind: "shell",
      displayName: "Main",
      cwd,
      layoutPath,
      environmentPath,
    });

    await expect(runtime.delete(RUNTIME_ID)).rejects.toThrow("Terminal runtime unavailable");
    await expect(readFile(
      join(homePath, "system", "terminal-runtimes", `${RUNTIME_ID}.json`),
      "utf8",
    )).resolves.toContain(environmentPath);
  });

  it("retains the descriptor when stop fails and never leaks raw systemctl errors", async () => {
    const runCommand = vi.fn<UserSystemdCommandRunner>()
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockRejectedValueOnce(new Error("failed /opt/matrix/internal provider"));
    const runtime = createUserSystemdTerminalRuntime({
      homePath,
      uid: 1001,
      generation: GENERATION,
      runCommand,
      readinessProbe: vi.fn(async () => true),
      now: () => "2026-07-31T12:00:00.000Z",
    });
    await runtime.create({ runtimeId: RUNTIME_ID, scope: "terminal", kind: "shell", displayName: "Main", cwd, layoutPath });

    await expect(runtime.delete(RUNTIME_ID)).rejects.toThrow("Terminal runtime unavailable");
    await expect(readFile(
      join(homePath, "system", "terminal-runtimes", `${RUNTIME_ID}.json`),
      "utf8",
    )).resolves.toContain(RUNTIME_ID);
  });

  it("lists bounded valid descriptors, resolves display names, and reports unit liveness", async () => {
    const runCommand = vi.fn<UserSystemdCommandRunner>(async (_command, args) => ({
      stdout: args.includes("is-active") ? "active\n" : "",
      stderr: "",
    }));
    const runtime = createUserSystemdTerminalRuntime({
      homePath,
      uid: 1001,
      generation: GENERATION,
      runCommand,
      readinessProbe: vi.fn(async () => true),
      now: () => "2026-07-31T12:00:00.000Z",
    });
    await runtime.create({
      runtimeId: RUNTIME_ID,
      scope: "terminal",
      kind: "shell",
      displayName: "Main",
      cwd,
      layoutPath,
    });
    await writeFile(join(homePath, "system", "terminal-runtimes", "invalid.json"), "{}\n");

    await expect(runtime.list({ scope: "terminal", runningOnly: true })).resolves.toEqual([
      expect.objectContaining({ runtimeId: RUNTIME_ID, displayName: "Main" }),
    ]);
    await expect(runtime.findByDisplayName("terminal", "Main")).resolves.toMatchObject({ runtimeId: RUNTIME_ID });
    expect(runCommand).toHaveBeenCalledWith(
      "systemctl",
      ["--user", "is-active", `matrix-zellij@${RUNTIME_ID}.service`],
      expect.any(Object),
    );
  });

  it("fails closed when owner state exceeds the bounded descriptor inventory", async () => {
    const descriptorRoot = join(homePath, "system", "terminal-runtimes");
    await mkdir(descriptorRoot, { recursive: true });
    await Promise.all(Array.from({ length: 257 }, async (_value, index) => {
      const id = `rt_${index.toString(16).padStart(32, "0")}`;
      await writeFile(join(descriptorRoot, `${id}.json`), "{}\n");
    }));
    const runtime = createUserSystemdTerminalRuntime({ homePath, uid: 1001, generation: GENERATION });

    await expect(runtime.list()).rejects.toThrow("Terminal runtime unavailable");
  });

  it("renames only terminal display metadata while preserving immutable runtime identity", async () => {
    const runCommand = vi.fn<UserSystemdCommandRunner>(async () => ({ stdout: "", stderr: "" }));
    const runtime = createUserSystemdTerminalRuntime({
      homePath,
      uid: 1001,
      generation: GENERATION,
      runCommand,
      readinessProbe: vi.fn(async () => true),
      now: () => "2026-07-31T12:00:00.000Z",
    });
    await runtime.create({
      runtimeId: RUNTIME_ID,
      scope: "terminal",
      kind: "shell",
      displayName: "Before",
      cwd,
      layoutPath,
    });

    const renamed = await runtime.renameDisplayName(RUNTIME_ID, "After");

    expect(renamed).toMatchObject({
      runtimeId: RUNTIME_ID,
      sessionName: `matrix-${RUNTIME_ID}`,
      displayName: "After",
      createdAt: "2026-07-31T12:00:00.000Z",
    });
    expect(runCommand).toHaveBeenCalledTimes(1);
  });
});
