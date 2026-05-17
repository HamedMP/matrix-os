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
      if (args[0] === "auth" && command === "codex") {
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
        "exec",
        "--skip-git-repo-check",
        "--ask-for-approval",
        "never",
        "--sandbox",
        "workspace-write",
        "--writable-root",
        "/tmp/matrixos-codex",
        "--",
        "fix tests; rm -rf /",
      ],
      cwd: "/home/matrixos/home/projects/repo/worktrees/wt_123",
      env: {},
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
          "exec",
          "--skip-git-repo-check",
          "--ask-for-approval",
          "never",
          "--sandbox",
          "workspace-write",
          "--writable-root",
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
    expect(launch.args.slice(0, 4)).toEqual(["exec", "--skip-git-repo-check", "--ask-for-approval", "never"]);
    const sandboxIndex = launch.args.indexOf("--sandbox");
    const writableRootIndex = launch.args.indexOf("--writable-root");
    const dashDashIndex = launch.args.indexOf("--");
    expect(sandboxIndex).toBeGreaterThan(3);
    expect(writableRootIndex).toBeGreaterThan(sandboxIndex);
    expect(dashDashIndex).toBeGreaterThan(writableRootIndex);
    expect(launch.args.at(-1)).toBe("--help");
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
    }).args).toEqual(["exec", "--skip-git-repo-check", "--ask-for-approval", "never", "--dangerously-bypass-sandbox", "--", "work"]);
  });

  it("validates supported agent IDs", () => {
    expect(SupportedAgentSchema.safeParse("claude").success).toBe(true);
    expect(SupportedAgentSchema.safeParse("bad-agent").success).toBe(false);
  });
});
