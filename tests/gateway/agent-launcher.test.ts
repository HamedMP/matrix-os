import { describe, it, expect, vi } from "vitest";
import { CODEX_VERIFIED_VERSION } from "../../packages/contracts/src/index.js";
import {
  buildAgentLaunch,
  buildAgentRuntimeEnvironment,
  createAgentLauncher,
  SupportedAgentSchema,
} from "../../packages/gateway/src/agent-launcher.js";

describe("agent-launcher", () => {
  it("forwards validated execution budgets through the isolated runtime environment", () => {
    vi.stubEnv("MATRIX_CODEX_TOOL_DEADLINE_MS", "120000");
    vi.stubEnv("MATRIX_CODEX_COMMAND_DEADLINE_MS", "3600000");
    vi.stubEnv("MATRIX_CODEX_NO_PROGRESS_MS", "not-a-number");
    vi.stubEnv("MATRIX_CODEX_TURN_DEADLINE_MS", "86400001");
    try {
      const env = buildAgentRuntimeEnvironment("/tmp/runtime-owner");
      expect(env.MATRIX_CODEX_TOOL_DEADLINE_MS).toBe("120000");
      expect(env.MATRIX_CODEX_COMMAND_DEADLINE_MS).toBe("3600000");
      expect(env.MATRIX_CODEX_NO_PROGRESS_MS).toBeUndefined();
      expect(env.MATRIX_CODEX_TURN_DEADLINE_MS).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });
  function commandError(code: string, message = code): Error & { code: string } {
    return Object.assign(new Error(message), { code });
  }

  function claudeSettings(args: string[]): Record<string, unknown> {
    const settingsIndex = args.indexOf("--settings");
    expect(settingsIndex).toBeGreaterThanOrEqual(0);
    return JSON.parse(args[settingsIndex + 1]!) as Record<string, unknown>;
  }

  function codexAppServerSettings(args: string[]): Record<string, unknown> {
    return JSON.parse(Buffer.from(args.at(-1)!, "base64").toString("utf8")) as Record<string, unknown>;
  }

  it("starts all four installation probes before any finishes and keeps stable order", async () => {
    const started: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runCommand = vi.fn(async (command: string, args: string[], options: { timeout: number }) => {
      expect(args).toEqual(["--version"]);
      expect(options.timeout).toBe(5_000);
      started.push(command);
      await gate;
      return {
        stdout: command === "codex" ? `codex-cli ${CODEX_VERIFIED_VERSION}\n` : `${command} 1.0.0\n`,
        stderr: "",
      };
    });
    const launcher = createAgentLauncher({ runCommand });

    const resultPromise = launcher.detectAgentInstallations();
    await vi.waitFor(() => {
      expect(started).toEqual(["claude", "codex", "opencode", "pi"]);
    });
    release();

    const result = await resultPromise;
    expect(result.agents.map((agent) => agent.id)).toEqual(["claude", "codex", "opencode", "pi"]);
  });

  it("isolates missing and timed-out installation probes without discarding successful results", async () => {
    const runCommand = vi.fn(async (command: string, args: string[]) => {
      expect(args).toEqual(["--version"]);
      if (command === "opencode") throw commandError("ENOENT", "private missing path");
      if (command === "codex") throw commandError("ETIMEDOUT", "private timeout detail");
      return { stdout: `${command} 1.0.0\n`, stderr: "" };
    });
    const launcher = createAgentLauncher({ runCommand });

    const result = await launcher.detectAgentInstallations();

    expect(result.agents.find((agent) => agent.id === "claude")).toMatchObject({
      installState: "installed",
      installed: true,
      authState: "unknown",
      errorCode: null,
    });
    expect(result.agents.find((agent) => agent.id === "codex")).toMatchObject({
      installState: "unknown",
      installed: null,
      errorCode: "agent_check_failed",
    });
    expect(result.agents.find((agent) => agent.id === "opencode")).toMatchObject({
      installState: "missing",
      installed: false,
      authState: "unknown",
      errorCode: "agent_missing",
    });
    expect(result.agents.find((agent) => agent.id === "pi")).toMatchObject({
      installState: "installed",
      installed: true,
      errorCode: null,
    });
    expect(JSON.stringify(result)).not.toContain("private");
  });

  it("never invokes authentication commands during installation detection", async () => {
    const runCommand = vi.fn(async (command: string) => ({
      stdout: command === "codex" ? `codex-cli ${CODEX_VERIFIED_VERSION}\n` : `${command} 1.0.0\n`,
      stderr: "",
    }));
    const launcher = createAgentLauncher({ runCommand });

    await launcher.detectAgentInstallations();

    expect(runCommand).toHaveBeenCalledTimes(4);
    expect(runCommand.mock.calls.every(([, args]) => args[0] === "--version")).toBe(true);
  });

  it("checks Claude and Codex credentials concurrently after each version probe", async () => {
    const started: string[] = [];
    let releaseVersions!: () => void;
    let releaseAuth!: () => void;
    const versionGate = new Promise<void>((resolve) => {
      releaseVersions = resolve;
    });
    const authGate = new Promise<void>((resolve) => {
      releaseAuth = resolve;
    });
    const runCommand = vi.fn(async (command: string, args: string[]) => {
      const key = `${command}:${args.join(" ")}`;
      started.push(key);
      if (args[0] === "--version") {
        await versionGate;
        return {
          stdout: command === "codex" ? `codex-cli ${CODEX_VERIFIED_VERSION}\n` : `${command} 1.0.0\n`,
          stderr: "",
        };
      }
      await authGate;
      return { stdout: "ok\n", stderr: "" };
    });
    const launcher = createAgentLauncher({ runCommand });

    const resultPromise = launcher.detectAgentCredentials();
    await vi.waitFor(() => {
      expect(started).toEqual(["claude:--version", "codex:--version"]);
    });
    releaseVersions();
    await vi.waitFor(() => {
      expect(started).toEqual([
        "claude:--version",
        "codex:--version",
        "claude:auth status",
        "codex:login status",
      ]);
    });
    releaseAuth();

    const result = await resultPromise;
    expect(result.agents.map((agent) => agent.id)).toEqual(["claude", "codex"]);
    expect(result.agents.every((agent) => agent.authState === "ok")).toBe(true);
  });

  it("distinguishes auth-required exits from credential check failures", async () => {
    const runCommand = vi.fn(async (command: string, args: string[]) => {
      if (args[0] === "--version") {
        return {
          stdout: command === "codex" ? `codex-cli ${CODEX_VERIFIED_VERSION}\n` : `${command} 1.0.0\n`,
          stderr: "",
        };
      }
      if (command === "claude") throw Object.assign(new Error("not logged in"), { code: 1 });
      throw commandError("ETIMEDOUT", "credential probe timed out");
    });
    const launcher = createAgentLauncher({ runCommand });

    const result = await launcher.detectAgentCredentials();

    expect(result.agents.find((agent) => agent.id === "claude")).toMatchObject({
      installState: "installed",
      authState: "required",
      errorCode: "agent_auth_required",
    });
    expect(result.agents.find((agent) => agent.id === "codex")).toMatchObject({
      installState: "installed",
      authState: "error",
      errorCode: "agent_check_failed",
    });
  });

  it.each([
    { output: "Not logged in\n", authState: "required", errorCode: "agent_auth_required" },
    { output: "Error checking login status: key must be a string at line 1 column 2\n", authState: "error", errorCode: "agent_check_failed" },
  ] as const)("classifies the exact Codex login-status result: $authState", async ({ output, authState, errorCode }) => {
    const runCommand = vi.fn(async (command: string, args: string[]) => {
      if (args[0] === "--version") {
        return {
          stdout: command === "codex" ? `codex-cli ${CODEX_VERIFIED_VERSION}\n` : `${command} 1.0.0\n`,
          stderr: "",
        };
      }
      if (command === "codex" && args.join(" ") === "login status") {
        throw Object.assign(new Error("Codex login status exited 1"), {
          code: 1, stdout: output.startsWith("Not logged in") ? output : "",
          stderr: output.startsWith("Error checking") ? output : "",
        });
      }
      return { stdout: "ok\n", stderr: "" };
    });
    const launcher = createAgentLauncher({ runCommand, runtimeHome: "/tmp/fixture-owner-home" });

    const result = await launcher.detectAgentCredentials();

    expect(result.agents.find((agent) => agent.id === "codex")).toMatchObject({
      installState: "installed", workspaceCompatibility: "compatible", authState, errorCode,
    });
    expect(result.agents.find((agent) => agent.id === "claude")).toMatchObject({
      installState: "installed", authState: "ok",
    });
  });

  it("binds a local Codex login observation to the selected executable, owner home, Codex home, and profile source", async () => {
    vi.stubEnv("CODEX_HOME", "/tmp/codex-observation-profile");
    let now = Date.parse("2026-09-26T00:00:00.000Z");
    const runCommand = vi.fn(async (_command: string, args: string[]) => ({
      stdout: args[0] === "--version"
        ? `codex-cli ${CODEX_VERIFIED_VERSION}\n`
        : "Logged in using ChatGPT\n",
      stderr: "",
    }));
    try {
      const launcher = createAgentLauncher({
        runCommand,
        runtimeHome: "/tmp/codex-observation-owner",
        codexExecutable: "/tmp/codex-observation-bin",
        now: () => now,
      });
      const binding = {
        executable: "/tmp/codex-observation-bin",
        runtimeHome: "/tmp/codex-observation-owner",
        codexHome: "/tmp/codex-observation-profile",
        accessSourceId: "owner_openai_profile" as const,
      };
      const observed = await launcher.observeCodexLocalCredential(binding);
      expect(observed).toEqual({
        accessSourceId: "owner_openai_profile",
        state: "present_unverified",
        checkedAt: "2026-09-26T00:00:00.000Z",
        staleAfter: "2026-09-26T00:00:05.000Z",
      });
      const calls = runCommand.mock.calls.length;
      for (const mismatch of [
        { ...binding, executable: "/tmp/other-codex-bin" },
        { ...binding, runtimeHome: "/tmp/other-owner" },
        { ...binding, codexHome: "/tmp/other-profile" },
        { ...binding, accessSourceId: "other_source" as const },
      ]) {
        expect((await launcher.observeCodexLocalCredential(mismatch)).state).toBe("unknown");
      }
      expect(runCommand).toHaveBeenCalledTimes(calls);
      now += 5_001;
      expect((await launcher.observeCodexLocalCredential(binding)).checkedAt).toBe("2026-09-26T00:00:05.001Z");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("recognizes the pinned CLI's stderr-only status and rejects warning-contaminated output", async () => {
    let codexStatus = "Logged in using ChatGPT\n";
    const launcher = createAgentLauncher({
      runtimeHome: "/tmp/codex-stderr-owner", codexExecutable: "/tmp/codex-stderr-bin",
      runCommand: async (command, args) => command === "/tmp/codex-stderr-bin"
        ? { stdout: args[0] === "--version" ? `codex-cli ${CODEX_VERIFIED_VERSION}\n` : "",
          stderr: args[0] === "--version" ? "" : codexStatus }
        : { stdout: args[0] === "--version" ? "claude 1.0.0\n" : "ok\n", stderr: "" },
    });
    const binding = {
      executable: "/tmp/codex-stderr-bin", runtimeHome: "/tmp/codex-stderr-owner",
      codexHome: process.env.CODEX_HOME, accessSourceId: "owner_openai_profile",
    };
    expect((await launcher.observeCodexLocalCredential(binding)).state).toBe("present_unverified");
    launcher.invalidateCredentialDetection();
    codexStatus = "Warning: local configuration changed\nLogged in using ChatGPT\n";
    expect((await launcher.observeCodexLocalCredential(binding)).state).toBe("unknown");
  });

  it("does not borrow a newer scan's cache expiry for an invalidated in-flight Codex result", async () => {
    let releaseOldStatus!: (value: { stdout: string; stderr: string }) => void;
    let firstStatusStarted!: () => void;
    const started = new Promise<void>((resolve) => { firstStatusStarted = resolve; });
    const oldStatus = new Promise<{ stdout: string; stderr: string }>((resolve) => { releaseOldStatus = resolve; });
    let statusCalls = 0;
    const launcher = createAgentLauncher({
      runtimeHome: "/tmp/codex-race-owner", codexExecutable: "/tmp/codex-race-bin",
      runCommand: async (command, args) => {
        if (command !== "/tmp/codex-race-bin") return { stdout: args[0] === "--version" ? "claude 1.0.0\n" : "ok\n", stderr: "" };
        if (args[0] === "--version") return { stdout: `codex-cli ${CODEX_VERIFIED_VERSION}\n`, stderr: "" };
        statusCalls += 1;
        if (statusCalls === 1) { firstStatusStarted(); return oldStatus; }
        throw Object.assign(new Error("Not logged in"), { code: 1, stdout: "", stderr: "Not logged in\n" });
      },
    });
    const binding = {
      executable: "/tmp/codex-race-bin", runtimeHome: "/tmp/codex-race-owner",
      codexHome: process.env.CODEX_HOME, accessSourceId: "owner_openai_profile",
    };
    const stale = launcher.observeCodexLocalCredential(binding);
    await started;
    launcher.invalidateCredentialDetection();
    expect((await launcher.observeCodexLocalCredential(binding)).state).toBe("absent");
    releaseOldStatus({ stdout: "Logged in using ChatGPT\n", stderr: "" });
    expect((await stale).state).toBe("unknown");
  });

  it("does not bind a locally configured API key to the selected Codex profile", async () => {
    const launcher = createAgentLauncher({
      runtimeHome: "/tmp/codex-observation-owner",
      codexExecutable: "/tmp/codex-observation-bin",
      runCommand: async (_command, args) => ({
        stdout: args[0] === "--version"
          ? `codex-cli ${CODEX_VERIFIED_VERSION}\n`
          : "Logged in using an API key - fixture_***_only\n",
        stderr: "",
      }),
    });
    expect(await launcher.observeCodexLocalCredential({
      executable: "/tmp/codex-observation-bin",
      runtimeHome: "/tmp/codex-observation-owner",
      codexHome: process.env.CODEX_HOME,
      accessSourceId: "owner_openai_profile",
    })).toMatchObject({ state: "unknown" });
  });

  it("checks auth with the Matrix runtime home so terminal logins are reused", async () => {
    const runCommand = vi.fn(async (command: string, args: string[]) => ({
      stdout: command === "codex" && args[0] === "--version"
        ? `codex-cli ${CODEX_VERIFIED_VERSION}\n`
        : "ok\n",
      stderr: "",
    }));
    const launcher = createAgentLauncher({
      runCommand,
      cwd: "/home/matrix/home",
      runtimeHome: "/home/matrix/home",
    });

    await launcher.detectAgentCredentials();

    expect(runCommand).toHaveBeenCalledWith("codex", ["login", "status"], expect.objectContaining({
      cwd: "/home/matrix/home",
      env: expect.objectContaining({
        HOME: "/home/matrix/home",
        MATRIX_HOME: "/home/matrix/home",
      }),
    }));
  });

  it("detects agents with the Matrix node prefix on PATH", async () => {
    const originalPath = process.env.PATH;
    const originalNodePrefix = process.env.MATRIX_NODE_PREFIX;
    process.env.PATH = "/usr/local/bin:/usr/bin:/bin";
    process.env.MATRIX_NODE_PREFIX = "/opt/matrix/runtime/node";
    const runCommand = vi.fn(async () => ({ stdout: "ok\n", stderr: "" }));
    const launcher = createAgentLauncher({
      runCommand,
      cwd: "/home/matrix/home",
      runtimeHome: "/home/matrix/home",
    });

    try {
      await launcher.detectAgentInstallations();
    } finally {
      if (originalPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = originalPath;
      }
      if (originalNodePrefix === undefined) {
        delete process.env.MATRIX_NODE_PREFIX;
      } else {
        process.env.MATRIX_NODE_PREFIX = originalNodePrefix;
      }
    }

    expect(runCommand).toHaveBeenCalledWith("claude", ["--version"], expect.objectContaining({
      env: expect.objectContaining({
        PATH: "/home/matrix/home/.local/bin:/opt/matrix/runtime/node/bin:/usr/local/bin:/usr/bin:/bin",
      }),
    }));
  });

  it("uses one configured absolute Codex executable for detection and launch", async () => {
    const codexExecutable = "/opt/matrix/runtime/node/bin/codex";
    const runCommand = vi.fn(async (command: string, args: string[]) => ({
      stdout: command === codexExecutable && args[0] === "--version"
        ? `codex-cli ${CODEX_VERIFIED_VERSION}\n`
        : "ok\n",
      stderr: "",
    }));
    const launcher = createAgentLauncher({ runCommand, codexExecutable });

    await launcher.detectAgentCredentials();
    const launch = launcher.buildLaunch({
      agent: "codex",
      cwd: "/home/matrix/home/projects/repo",
      prompt: "fix tests",
      sandbox: { enabled: true, mode: "workspace-write" },
      providerEventPath: "/home/matrix/home/system/coding-agents/provider-events/sess_bound.jsonl",
    });

    expect(runCommand).toHaveBeenCalledWith(codexExecutable, ["--version"], expect.any(Object));
    expect(runCommand).toHaveBeenCalledWith(codexExecutable, ["login", "status"], expect.any(Object));
    expect(launch.command).toBe(process.execPath);
    expect(launch.args.slice(1, 4)).toEqual([
      "/home/matrix/home/system/coding-agents/provider-events/sess_bound.jsonl",
      CODEX_VERIFIED_VERSION,
      codexExecutable,
    ]);
  });

  it("keeps an unverified configured Codex version installed but workspace-incompatible", async () => {
    const codexExecutable = "/opt/matrix/runtime/node/bin/codex";
    const runCommand = vi.fn(async (command: string, args: string[]) => {
      if (command === codexExecutable && args[0] === "--version") {
        return { stdout: "codex-cli 0.144.1\n", stderr: "" };
      }
      return { stdout: `${command} 1.0.0\n`, stderr: "" };
    });
    const launcher = createAgentLauncher({ runCommand, codexExecutable });

    const result = await launcher.detectAgentInstallations();

    expect(result.agents.find((agent) => agent.id === "codex")).toMatchObject({
      installState: "installed",
      installed: true,
      authState: "unknown",
      workspaceCompatibility: "unsupported",
      errorCode: "agent_version_unsupported",
      version: "codex-cli 0.144.1",
    });
    expect(runCommand).not.toHaveBeenCalledWith(codexExecutable, ["login", "status"], expect.any(Object));
  });

  it("reports unsupported Codex credentials without running the authentication probe", async () => {
    const runCommand = vi.fn(async (command: string, args: string[]) => {
      if (command === "codex" && args[0] === "--version") {
        return { stdout: "codex-cli 0.144.1\n", stderr: "" };
      }
      return { stdout: `${command} 1.0.0\n`, stderr: "" };
    });
    const launcher = createAgentLauncher({ runCommand });

    const result = await launcher.detectAgentCredentials();

    expect(result.agents.find((agent) => agent.id === "codex")).toMatchObject({
      installState: "installed",
      installed: true,
      authState: "error",
      workspaceCompatibility: "unsupported",
      errorCode: "agent_version_unsupported",
    });
    expect(runCommand).not.toHaveBeenCalledWith("codex", ["login", "status"], expect.any(Object));
  });

  it("deduplicates overlapping installation scans and expires the five-second cache", async () => {
    let now = 1_000;
    const runCommand = vi.fn(async (command: string) => ({
      stdout: command === "codex" ? `codex-cli ${CODEX_VERIFIED_VERSION}\n` : `${command} 1.0.0\n`,
      stderr: "",
    }));
    const launcher = createAgentLauncher({ runCommand, now: () => now });

    const [first, overlapping] = await Promise.all([
      launcher.detectAgentInstallations(),
      launcher.detectAgentInstallations(),
    ]);
    expect(overlapping).toBe(first);
    expect(runCommand).toHaveBeenCalledTimes(4);

    expect(await launcher.detectAgentInstallations()).toBe(first);
    expect(runCommand).toHaveBeenCalledTimes(4);

    now += 5_001;
    expect(await launcher.detectAgentInstallations()).not.toBe(first);
    expect(runCommand).toHaveBeenCalledTimes(8);
  });

  it("invalidates cached credential probes after a foreground Terminal login", async () => {
    let codexAuthenticated = false;
    const runCommand = vi.fn(async (command: string, args: string[]) => {
      if (args[0] === "--version") {
        return {
          stdout: command === "codex" ? `codex-cli ${CODEX_VERIFIED_VERSION}\n` : `${command} 1.0.0\n`,
          stderr: "",
        };
      }
      if (command === "codex" && args.join(" ") === "login status" && !codexAuthenticated) {
        throw Object.assign(new Error("not authenticated"), { code: 1, stdout: "Not logged in\n" });
      }
      return { stdout: "ok\n", stderr: "" };
    });
    const launcher = createAgentLauncher({ runCommand, now: () => 1_000 });

    const before = await launcher.detectAgentCredentials();
    expect(before.agents.find((agent) => agent.id === "codex"))
      .toMatchObject({ authState: "required" });

    codexAuthenticated = true;
    launcher.invalidateCredentialDetection();

    const after = await launcher.detectAgentCredentials();
    expect(after.agents.find((agent) => agent.id === "codex"))
      .toMatchObject({ authState: "ok" });
  });

  it("constructs non-interactive Codex exec argv without shell interpolation", () => {
    const launch = buildAgentLaunch({
      agent: "codex",
      cwd: "/home/matrixos/home/projects/repo/worktrees/wt_123",
      prompt: "fix tests; rm -rf /",
      sandbox: { enabled: true, writableRoots: ["/tmp/matrixos-codex"] },
    });

    expect(launch).toEqual({
      command: "codex",
      args: [
        "--ask-for-approval",
        "never",
        "--sandbox",
        "workspace-write",
        "--add-dir",
        "/tmp/matrixos-codex",
        "exec",
        "--skip-git-repo-check",
        "--",
        "fix tests; rm -rf /",
      ],
      cwd: "/home/matrixos/home/projects/repo/worktrees/wt_123",
      env: {},
    });
  });

  it("launches agents with the Matrix runtime home so CLI auth files are visible", () => {
    const launcher = createAgentLauncher({ runtimeHome: "/home/matrix/home" });

    const launch = launcher.buildLaunch({
      agent: "codex",
      cwd: "/home/matrix/home/projects/repo/worktrees/wt_123",
      prompt: "fix tests",
      sandbox: { enabled: true, writableRoots: ["/home/matrix/home/projects/repo/worktrees/wt_123"] },
    });

    expect(launch.env).toMatchObject({
      HOME: "/home/matrix/home",
      MATRIX_HOME: "/home/matrix/home",
    });
  });

  it("inserts end-of-options before prompt for interactive agents to prevent flag injection", () => {
    const agents = ["claude", "codex", "opencode", "pi"] as const;
    for (const agent of agents) {
      const launch = buildAgentLaunch({
        agent,
        cwd: "/home/matrixos/home/projects/repo",
        prompt: "--dangerously-bypass-sandbox",
        sandbox: agent === "codex" || agent === "claude"
          ? { enabled: true, writableRoots: ["/tmp/sandbox"] }
          : undefined,
      });
      if (agent === "codex") {
        expect(launch.args).toEqual([
          "--ask-for-approval",
          "never",
          "--sandbox",
          "workspace-write",
          "--add-dir",
          "/tmp/sandbox",
          "exec",
          "--skip-git-repo-check",
          "--",
          "--dangerously-bypass-sandbox",
        ]);
      }
      const dashDashIndex = launch.args.indexOf("--");
      const promptIndex = launch.args.indexOf("--dangerously-bypass-sandbox");
      expect(dashDashIndex).toBeGreaterThanOrEqual(0);
      expect(promptIndex).toBeGreaterThan(dashDashIndex);
    }
  });

  it("omits end-of-options when prompt is empty or missing", () => {
    const launch = buildAgentLaunch({
      agent: "claude",
      cwd: "/home/matrixos/home/projects/repo",
      sandbox: { enabled: true, writableRoots: ["/home/matrixos/home/projects/repo"] },
    });
    expect(launch.args).not.toContain("--");

    const launchEmpty = buildAgentLaunch({
      agent: "claude",
      cwd: "/home/matrixos/home/projects/repo",
      prompt: "",
      sandbox: { enabled: true, writableRoots: ["/home/matrixos/home/projects/repo"] },
    });
    expect(launchEmpty.args).not.toContain("--");
  });

  it("places Codex security controls before exec and the prompt last", () => {
    const launch = buildAgentLaunch({
      agent: "codex",
      cwd: "/home/matrixos/home/projects/repo",
      prompt: "--help",
      sandbox: { enabled: true, writableRoots: ["/tmp/sandbox"] },
    });
    const sandboxIndex = launch.args.indexOf("--sandbox");
    const writableRootIndex = launch.args.indexOf("--add-dir");
    const execIndex = launch.args.indexOf("exec");
    const dashDashIndex = launch.args.indexOf("--");
    expect(sandboxIndex).toBeGreaterThan(1);
    expect(writableRootIndex).toBeGreaterThan(sandboxIndex);
    expect(execIndex).toBeGreaterThan(writableRootIndex);
    expect(dashDashIndex).toBeGreaterThan(execIndex);
    expect(launch.args.at(-1)).toBe("--help");
  });

  it("applies explicit Codex approval and read-only sandbox settings", () => {
    const launch = buildAgentLaunch({
      agent: "codex",
      cwd: "/home/matrixos/home/projects/repo",
      prompt: "review only",
      approvalPolicy: "on-request",
      sandbox: { enabled: true, mode: "read-only", writableRoots: ["/tmp/ignored"] },
    });

    expect(launch.args).toEqual([
      "--ask-for-approval",
      "on-request",
      "--sandbox",
      "read-only",
      "exec",
      "--skip-git-repo-check",
      "--",
      "review only",
    ]);
  });

  it("passes the persisted native Codex thread to the app-server runner", () => {
    const launch = buildAgentLaunch({
      agent: "codex",
      cwd: "/home/matrixos/home/projects/repo",
      prompt: "continue the task",
      providerThreadId: "native_thread_persisted_1",
      providerEventPath: "/tmp/codex-events.jsonl",
      sandbox: { enabled: true, mode: "workspace-write", writableRoots: [] },
    });

    expect(codexAppServerSettings(launch.args)).toMatchObject({
      providerThreadId: "native_thread_persisted_1",
    });
  });

  it("maps Codex review and plan modes into launch controls", () => {
    const reviewLaunch = buildAgentLaunch({
      agent: "codex",
      cwd: "/home/matrixos/home/projects/repo",
      prompt: "check this PR",
      mode: "review",
      sandbox: { enabled: true, mode: "read-only" },
    });

    expect(reviewLaunch.args).toEqual([
      "--ask-for-approval",
      "never",
      "--sandbox",
      "read-only",
      "exec",
      "--skip-git-repo-check",
      "review",
      "--",
      "check this PR",
    ]);

    const planLaunch = buildAgentLaunch({
      agent: "codex",
      cwd: "/home/matrixos/home/projects/repo",
      prompt: "add a dashboard",
      mode: "plan",
      sandbox: { enabled: true, mode: "workspace-write" },
    });

    expect(planLaunch.args.at(-1)).toContain("Plan the work first");
    expect(planLaunch.args.at(-1)).toContain("add a dashboard");
  });

  it("requires Codex sandbox metadata unless explicitly overridden", () => {
    expect(() => buildAgentLaunch({
      agent: "codex",
      cwd: "/home/matrixos/home/projects/repo",
      prompt: "work",
    })).toThrow("Codex sandbox preflight is required");

    expect(buildAgentLaunch({
      agent: "codex",
      cwd: "/home/matrixos/home/projects/repo",
      prompt: "work",
      sandbox: { enabled: false, adminOverride: true },
    }).args).toEqual(["--ask-for-approval", "never", "--dangerously-bypass-approvals-and-sandbox", "exec", "--skip-git-repo-check", "--", "work"]);
  });

  it("constructs a strict workspace-scoped Claude launch policy", () => {
    const cwd = "/home/matrix/home/projects/repo/worktrees/wt_abc123def456";
    const scratch = "/home/matrix/home/system/agent-scratch/sess_abc123";
    const launch = buildAgentLaunch({
      agent: "claude",
      cwd,
      prompt: "fix the tests",
      model: "claude-sonnet-4-5",
      approvalPolicy: "on-request",
      sandbox: { enabled: true, mode: "workspace-write", writableRoots: [cwd, scratch] },
    });

    expect(launch.args).toEqual([
      "--setting-sources",
      "",
      "--settings",
      expect.any(String),
      "--permission-mode",
      "dontAsk",
      "--strict-mcp-config",
      "--no-chrome",
      "--model",
      "claude-sonnet-4-5",
      "--print",
      "--",
      "fix the tests",
    ]);
    expect(claudeSettings(launch.args)).toEqual({
      permissions: {
        allow: [
          "Edit(//home/matrix/home/projects/repo/worktrees/wt_abc123def456/**)",
          "Edit(//home/matrix/home/system/agent-scratch/sess_abc123/**)",
        ],
      },
      sandbox: {
        enabled: true,
        failIfUnavailable: true,
        autoAllowBashIfSandboxed: true,
        allowUnsandboxedCommands: false,
        filesystem: { allowWrite: [cwd, scratch] },
      },
    });
  });

  it("enforces read-only Claude launches across built-in edits and subprocesses", () => {
    const cwd = "/home/matrix/home/projects/repo/worktrees/wt_abc123def456";
    const gitCommonDir = "/home/matrix/home/projects/repo/repo/.git";
    const launch = buildAgentLaunch({
      agent: "claude",
      cwd,
      prompt: "review only",
      approvalPolicy: "never",
      sandbox: {
        enabled: true,
        mode: "read-only",
        writableRoots: [],
        denyWriteRoots: [cwd, gitCommonDir],
      },
    });

    expect(launch.args).toContain("dontAsk");
    expect(claudeSettings(launch.args)).toEqual({
      permissions: { deny: ["Edit", "Write", "NotebookEdit"] },
      sandbox: {
        enabled: true,
        failIfUnavailable: true,
        autoAllowBashIfSandboxed: true,
        allowUnsandboxedCommands: false,
        filesystem: { denyWrite: [cwd, gitCommonDir] },
      },
    });
  });

  it("uses bounded no-prompt controls for Claude workspace and full-access launches", () => {
    const cwd = "/home/matrix/home/projects/repo/worktrees/wt_abc123def456";
    const scratch = "/home/matrix/home/system/agent-scratch/sess_abc123";
    const workspaceLaunch = buildAgentLaunch({
      agent: "claude",
      cwd,
      approvalPolicy: "never",
      sandbox: { enabled: true, mode: "workspace-write", writableRoots: [cwd, scratch] },
    });
    expect(workspaceLaunch.args).toContain("dontAsk");
    expect(workspaceLaunch.args).not.toContain("--print");
    expect(claudeSettings(workspaceLaunch.args)).toMatchObject({
      permissions: {
        allow: [
          "Edit(//home/matrix/home/projects/repo/worktrees/wt_abc123def456/**)",
          "Edit(//home/matrix/home/system/agent-scratch/sess_abc123/**)",
        ],
      },
      sandbox: { enabled: true, allowUnsandboxedCommands: false },
    });
    expect(claudeSettings(workspaceLaunch.args).permissions?.allow).not.toContain("Edit");
    expect(claudeSettings(workspaceLaunch.args).permissions?.allow).not.toContain("Bash");

    const fullAccessLaunch = buildAgentLaunch({
      agent: "claude",
      cwd,
      approvalPolicy: "never",
      sandbox: { enabled: true, mode: "danger-full-access", writableRoots: [] },
    });
    expect(fullAccessLaunch.args).toContain("bypassPermissions");
    expect(claudeSettings(fullAccessLaunch.args)).toEqual({ sandbox: { enabled: false } });
  });

  it("makes Claude plan and review modes OS-level read-only", () => {
    const cwd = "/home/matrix/home/projects/repo/worktrees/wt_abc123def456";
    const gitCommonDir = "/home/matrix/home/projects/repo/repo/.git";
    for (const mode of ["plan", "review"] as const) {
      const launch = buildAgentLaunch({
        agent: "claude",
        cwd,
        mode,
        approvalPolicy: "on-request",
        sandbox: {
          enabled: true,
          mode: mode === "review" ? "danger-full-access" : "workspace-write",
          writableRoots: [cwd],
          denyWriteRoots: [cwd, gitCommonDir],
        },
      });

      expect(launch.args).toContain("plan");
      expect(claudeSettings(launch.args)).toMatchObject({
        permissions: { deny: ["Edit", "Write", "NotebookEdit"] },
        sandbox: {
          enabled: true,
          autoAllowBashIfSandboxed: true,
          filesystem: { denyWrite: [cwd, gitCommonDir] },
        },
      });
    }
  });

  it("fails closed for unsupported Claude approval policy and missing preflight", () => {
    expect(() => buildAgentLaunch({
      agent: "claude",
      cwd: "/home/matrix/home/projects/repo",
      approvalPolicy: "on-failure",
      sandbox: { enabled: true, mode: "workspace-write", writableRoots: [] },
    })).toThrow("Claude approval policy is unavailable");

    expect(() => buildAgentLaunch({
      agent: "claude",
      cwd: "/home/matrix/home/projects/repo",
    })).toThrow("Claude sandbox preflight is required");
  });

  it("validates supported agent IDs", () => {
    expect(SupportedAgentSchema.safeParse("claude").success).toBe(true);
    expect(SupportedAgentSchema.safeParse("bad-agent").success).toBe(false);
  });
});
