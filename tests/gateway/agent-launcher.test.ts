import { describe, it, expect, vi } from "vitest";
import { CODEX_VERIFIED_VERSION } from "../../packages/contracts/src/index.js";
import {
  buildAgentLaunch,
  createAgentLauncher,
  SupportedAgentSchema,
} from "../../packages/gateway/src/agent-launcher.js";

describe("agent-launcher", () => {
  function claudeSettings(args: string[]): Record<string, unknown> {
    const settingsIndex = args.indexOf("--settings");
    expect(settingsIndex).toBeGreaterThanOrEqual(0);
    return JSON.parse(args[settingsIndex + 1]!) as Record<string, unknown>;
  }

  it("detects installed, missing, and auth-needed agents without leaking raw command errors", async () => {
    const runCommand = vi.fn(async (command: string, args: string[]) => {
      if (args[0] === "--version" && command !== "opencode") {
        return { stdout: `${command} 1.0.0\n`, stderr: "" };
      }
      if (args[0] === "--version" && command === "opencode") {
        throw new Error("ENOENT: opencode missing from /usr/bin");
      }
      if (args[0] === "login" && args[1] === "status" && command === "codex") {
        throw new Error("not logged in: token sk-secret");
      }
      return { stdout: "ok\n", stderr: "" };
    });
    const launcher = createAgentLauncher({ runCommand });

    const result = await launcher.detectAgents();

    expect(result.agents.find((agent) => agent.id === "claude")).toMatchObject({
      installed: true,
      authState: "ok",
    });
    expect(result.agents.find((agent) => agent.id === "codex")).toMatchObject({
      installed: true,
      authState: "required",
      errorCode: "agent_auth_required",
    });
    expect(result.agents.find((agent) => agent.id === "opencode")).toMatchObject({
      installed: false,
      authState: "unknown",
      errorCode: "agent_missing",
    });
    expect(JSON.stringify(result)).not.toContain("sk-secret");
  });

  it("checks auth with the Matrix runtime home so terminal logins are reused", async () => {
    const runCommand = vi.fn(async () => ({ stdout: "ok\n", stderr: "" }));
    const launcher = createAgentLauncher({
      runCommand,
      cwd: "/home/matrix/home",
      runtimeHome: "/home/matrix/home",
    });

    await launcher.detectAgents();

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
      await launcher.detectAgents();
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

    await launcher.detectAgents();
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

  it("marks an unverified configured Codex version unavailable before auth probing", async () => {
    const codexExecutable = "/opt/matrix/runtime/node/bin/codex";
    const runCommand = vi.fn(async (command: string, args: string[]) => {
      if (command === codexExecutable && args[0] === "--version") {
        return { stdout: "codex-cli 0.144.1\n", stderr: "" };
      }
      return { stdout: `${command} 1.0.0\n`, stderr: "" };
    });
    const launcher = createAgentLauncher({ runCommand, codexExecutable });

    const result = await launcher.detectAgents();

    expect(result.agents.find((agent) => agent.id === "codex")).toMatchObject({
      installed: false,
      authState: "unknown",
      errorCode: "agent_missing",
      version: "codex-cli 0.144.1",
    });
    expect(runCommand).not.toHaveBeenCalledWith(codexExecutable, ["login", "status"], expect.any(Object));
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
