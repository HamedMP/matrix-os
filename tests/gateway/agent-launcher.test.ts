import { describe, it, expect, vi } from "vitest";
import {
  buildAgentLaunch,
  createAgentLauncher,
  SupportedAgentSchema,
} from "../../packages/gateway/src/agent-launcher.js";

describe("agent-launcher", () => {
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
        "exec",
        "--skip-git-repo-check",
        "--sandbox",
        "workspace-write",
        "--add-dir",
        "/tmp/matrixos-codex",
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
        sandbox: agent === "codex" ? { enabled: true, writableRoots: ["/tmp/sandbox"] } : undefined,
      });
      if (agent === "codex") {
        expect(launch.args).toEqual([
          "--ask-for-approval",
          "never",
          "exec",
          "--skip-git-repo-check",
          "--sandbox",
          "workspace-write",
          "--add-dir",
          "/tmp/sandbox",
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
    });
    expect(launch.args).not.toContain("--");

    const launchEmpty = buildAgentLaunch({
      agent: "claude",
      cwd: "/home/matrixos/home/projects/repo",
      prompt: "",
    });
    expect(launchEmpty.args).not.toContain("--");
  });

  it("places Codex exec controls before sandbox flags and the prompt last", () => {
    const launch = buildAgentLaunch({
      agent: "codex",
      cwd: "/home/matrixos/home/projects/repo",
      prompt: "--help",
      sandbox: { enabled: true, writableRoots: ["/tmp/sandbox"] },
    });
    expect(launch.args.slice(0, 4)).toEqual(["--ask-for-approval", "never", "exec", "--skip-git-repo-check"]);
    const sandboxIndex = launch.args.indexOf("--sandbox");
    const writableRootIndex = launch.args.indexOf("--add-dir");
    const dashDashIndex = launch.args.indexOf("--");
    expect(sandboxIndex).toBeGreaterThan(3);
    expect(writableRootIndex).toBeGreaterThan(sandboxIndex);
    expect(dashDashIndex).toBeGreaterThan(writableRootIndex);
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
      "exec",
      "--skip-git-repo-check",
      "--sandbox",
      "read-only",
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
      "exec",
      "--skip-git-repo-check",
      "--sandbox",
      "read-only",
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
    }).args).toEqual(["--ask-for-approval", "never", "exec", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox", "--", "work"]);
  });

  it("validates supported agent IDs", () => {
    expect(SupportedAgentSchema.safeParse("claude").success).toBe(true);
    expect(SupportedAgentSchema.safeParse("bad-agent").success).toBe(false);
  });
});
