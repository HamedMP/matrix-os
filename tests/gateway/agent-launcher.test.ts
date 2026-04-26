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

  it("constructs argv arrays for supported agents without shell interpolation", () => {
    const launch = buildAgentLaunch({
      agent: "codex",
      cwd: "/home/matrixos/home/projects/repo/worktrees/wt_123",
      prompt: "fix tests; rm -rf /",
      sandbox: { enabled: true, writableRoots: ["/tmp/matrixos-codex"] },
    });

    expect(launch).toEqual({
      command: "codex",
      args: [
        "--sandbox",
        "workspace-write",
        "--writable-root",
        "/tmp/matrixos-codex",
        "fix tests; rm -rf /",
      ],
      cwd: "/home/matrixos/home/projects/repo/worktrees/wt_123",
      env: {},
    });
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
    }).args).toEqual(["--dangerously-bypass-sandbox", "work"]);
  });

  it("validates supported agent IDs", () => {
    expect(SupportedAgentSchema.safeParse("claude").success).toBe(true);
    expect(SupportedAgentSchema.safeParse("bad-agent").success).toBe(false);
  });
});
