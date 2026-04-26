import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  parseArgs,
  formatStatus,
  formatDoctor,
  formatProjectList,
  formatWorktreeList,
  buildWorkspaceRequest,
} from "../../bin/cli.js";
import type { StatusInfo, DoctorCheck } from "../../bin/cli.js";

describe("T680a: CLI argument parser", () => {
  it("parseArgs(['start']) returns { command: 'start' }", () => {
    const result = parseArgs(["start"]);
    expect(result.command).toBe("start");
  });

  it("parseArgs(['send', 'hello']) returns { command: 'send', message: 'hello' }", () => {
    const result = parseArgs(["send", "hello"]);
    expect(result.command).toBe("send");
    expect(result.message).toBe("hello");
  });

  it("parseArgs(['status']) returns { command: 'status' }", () => {
    const result = parseArgs(["status"]);
    expect(result.command).toBe("status");
  });

  it("parseArgs(['doctor']) returns { command: 'doctor' }", () => {
    const result = parseArgs(["doctor"]);
    expect(result.command).toBe("doctor");
  });

  it("parseArgs([]) returns { command: 'help' }", () => {
    const result = parseArgs([]);
    expect(result.command).toBe("help");
  });

  it("parseArgs(['help']) returns { command: 'help' }", () => {
    const result = parseArgs(["help"]);
    expect(result.command).toBe("help");
  });

  it("parseArgs(['version']) returns { command: 'version' }", () => {
    const result = parseArgs(["version"]);
    expect(result.command).toBe("version");
  });

  it("parseArgs(['--version']) returns { command: 'version' }", () => {
    const result = parseArgs(["--version"]);
    expect(result.command).toBe("version");
  });

  it("parseArgs(['--help']) returns { command: 'help' }", () => {
    const result = parseArgs(["--help"]);
    expect(result.command).toBe("help");
  });

  it("parses --gateway flag", () => {
    const result = parseArgs(["status", "--gateway", "http://localhost:5000"]);
    expect(result.command).toBe("status");
    expect(result.gateway).toBe("http://localhost:5000");
  });

  it("parses --token flag", () => {
    const result = parseArgs(["status", "--token", "my-token"]);
    expect(result.command).toBe("status");
    expect(result.token).toBe("my-token");
  });

  it("defaults gateway to http://localhost:4000", () => {
    const result = parseArgs(["status"]);
    expect(result.gateway).toBe("http://localhost:4000");
  });

  it("parses --shell flag for start command", () => {
    const result = parseArgs(["start", "--shell"]);
    expect(result.command).toBe("start");
    expect(result.shell).toBe(true);
  });

  it("parses --session flag for send command", () => {
    const result = parseArgs(["send", "hello", "--session", "abc-123"]);
    expect(result.command).toBe("send");
    expect(result.message).toBe("hello");
    expect(result.session).toBe("abc-123");
  });

  it("parses --no-stream flag for send command", () => {
    const result = parseArgs(["send", "hello", "--no-stream"]);
    expect(result.command).toBe("send");
    expect(result.noStream).toBe(true);
  });

  it("treats unknown command as help", () => {
    const result = parseArgs(["foobar"]);
    expect(result.command).toBe("help");
  });

  it("parses project, worktree, export, and delete workspace commands", () => {
    expect(parseArgs(["project", "add", "github.com/owner/repo", "--slug", "repo"])).toMatchObject({
      command: "project",
      subcommand: "add",
      positional: ["github.com/owner/repo"],
      slug: "repo",
    });
    expect(parseArgs(["worktree", "create", "repo", "--pr", "42"])).toMatchObject({
      command: "worktree",
      subcommand: "create",
      positional: ["repo"],
      pr: 42,
    });
    expect(parseArgs(["workspace", "export", "--project", "repo"])).toMatchObject({
      command: "workspace",
      subcommand: "export",
      project: "repo",
    });
    expect(parseArgs(["workspace", "delete", "--project", "repo", "--confirm", "delete project workspace data"])).toMatchObject({
      command: "workspace",
      subcommand: "delete",
      project: "repo",
      confirm: "delete project workspace data",
    });
  });
});

describe("workspace CLI helpers", () => {
  it("builds API requests for project and worktree commands", () => {
    expect(buildWorkspaceRequest(parseArgs(["project", "add", "github.com/owner/repo", "--slug", "repo"]))).toEqual({
      method: "POST",
      path: "/api/projects",
      body: { url: "github.com/owner/repo", slug: "repo" },
    });
    expect(buildWorkspaceRequest(parseArgs(["project", "prs", "repo"]))).toEqual({
      method: "GET",
      path: "/api/projects/repo/prs",
    });
    expect(buildWorkspaceRequest(parseArgs(["worktree", "create", "repo", "--branch", "main"]))).toEqual({
      method: "POST",
      path: "/api/projects/repo/worktrees",
      body: { branch: "main" },
    });
    expect(buildWorkspaceRequest(parseArgs(["worktree", "rm", "repo", "wt_abc123", "--confirm-dirty-delete"]))).toEqual({
      method: "DELETE",
      path: "/api/projects/repo/worktrees/wt_abc123",
      body: { confirmDirtyDelete: true },
    });
  });

  it("formats project and worktree lists for terminal output", () => {
    expect(formatProjectList({
      projects: [
        { slug: "repo", name: "Repo", github: { owner: "owner", repo: "repo" }, updatedAt: "2026-04-26T00:00:00.000Z" },
      ],
      nextCursor: null,
    })).toContain("repo");
    expect(formatWorktreeList({
      worktrees: [
        { id: "wt_abc123", currentBranch: "main", dirtyState: "clean", path: "/home/matrixos/home/projects/repo/worktrees/wt_abc123" },
      ],
    })).toContain("wt_abc123");
  });
});

describe("T680a: formatStatus", () => {
  it("renders readable status output for healthy gateway", () => {
    const info: StatusInfo = {
      healthy: true,
      health: { status: "ok", cronJobs: 2, channels: { telegram: true } },
      systemInfo: {
        version: "0.1.0",
        uptime: 3600,
        modules: 1,
        channels: { telegram: true },
        skills: 5,
        todayCost: 0.42,
      },
      channels: { telegram: { status: "running" } },
      cronJobs: [{ id: "1", message: "daily check", schedule: { type: "cron", expression: "0 9 * * *" } }],
    };

    const output = formatStatus(info);
    expect(output).toContain("Gateway");
    expect(output).toContain("healthy");
    expect(output).toContain("0.1.0");
    expect(output).toContain("1h 0m");
    expect(output).toContain("telegram");
    expect(output).toContain("daily check");
  });

  it("renders unreachable status", () => {
    const info: StatusInfo = {
      healthy: false,
      error: "Connection refused",
    };

    const output = formatStatus(info);
    expect(output).toContain("unreachable");
    expect(output).toContain("Connection refused");
  });
});

describe("T680a: formatDoctor", () => {
  it("renders pass/fail diagnostic results", () => {
    const checks: DoctorCheck[] = [
      { name: "Node.js version", passed: true, detail: "v24.0.0" },
      { name: "pnpm installed", passed: true, detail: "10.6.2" },
      { name: "ANTHROPIC_API_KEY", passed: false, detail: "Not set", fix: "export ANTHROPIC_API_KEY=sk-..." },
      { name: "Gateway reachable", passed: true, detail: "http://localhost:4000" },
      { name: "Home directory", passed: true, detail: "/home/user/matrixos" },
    ];

    const output = formatDoctor(checks);
    expect(output).toContain("PASS");
    expect(output).toContain("FAIL");
    expect(output).toContain("Node.js version");
    expect(output).toContain("ANTHROPIC_API_KEY");
    expect(output).toContain("export ANTHROPIC_API_KEY");
    expect(output).toContain("4 passed");
    expect(output).toContain("1 failed");
  });

  it("renders all-pass results", () => {
    const checks: DoctorCheck[] = [
      { name: "Node.js version", passed: true, detail: "v24.0.0" },
      { name: "pnpm installed", passed: true, detail: "10.6.2" },
    ];

    const output = formatDoctor(checks);
    expect(output).toContain("PASS");
    expect(output).not.toContain("FAIL");
    expect(output).toContain("2 passed");
    expect(output).toContain("All checks passed");
  });
});
