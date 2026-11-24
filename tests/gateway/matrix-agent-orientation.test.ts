import { describe, expect, it } from "vitest";
import { buildAgentLaunch } from "../../packages/gateway/src/agent-launcher.js";

describe("Claude Matrix orientation", () => {
  it.each(["call", "discovery"] as const)("appends the shared orientation without changing permissions for %s", (scope) => {
    const launch = buildAgentLaunch({ agent: "claude", cwd: "/owner/projects/app", runtimeHome: "/owner",
      prompt: "Build a tracker", matrixCustomMcp: true, matrixCustomMcpScope: scope,
      sandbox: { enabled: true, mode: "workspace-write", writableRoots: ["/owner/projects/app"] },
      approvalPolicy: "on-request" });
    const index = launch.args.indexOf("--append-system-prompt");
    expect(index).toBeGreaterThan(-1);
    const prompt = launch.args[index + 1]!;
    expect(prompt).toContain("## Matrix OS orientation");
    expect(Buffer.byteLength(prompt)).toBeLessThan(1_500);
    expect(prompt).toContain("Matrix Core MCP");
    expect(prompt).toContain("search_tools");
    expect(prompt).toContain("describe_tool");
    expect(prompt).not.toContain("compositor-friendly properties");
    expect(prompt).toContain("window.MatrixOS.db");
    expect(prompt).toContain("matrix-app-builder");
    expect(prompt).toContain("Only use tools present in this run");
    expect(prompt).not.toContain("mcp__matrix-os-ipc__manage_cron");
    expect(prompt).not.toContain("matrix-integrations call");
    expect(prompt).toContain(scope === "call" ? "broker owns approval" : "discovery only");
    if (scope === "call") expect(prompt).toContain("call_tool");
    else expect(prompt).not.toContain("call_tool");
    expect(launch.args[launch.args.indexOf("--permission-mode") + 1]).toBe("dontAsk");
    expect(launch.args[launch.args.indexOf("--setting-sources") + 1]).toBe("");
  });

  it("does not inject Matrix instructions into a generic launch without a runtime home", () => {
    const launch = buildAgentLaunch({ agent: "claude", cwd: "/project", prompt: "Inspect",
      sandbox: { enabled: true, mode: "read-only" } });
    expect(launch.args).not.toContain("--append-system-prompt");
  });

  it.each([
    { mode: "plan" as const, sandboxMode: "workspace-write" as const, approvalPolicy: "on-request" as const },
    { mode: "review" as const, sandboxMode: "workspace-write" as const, approvalPolicy: "on-request" as const },
    { mode: undefined, sandboxMode: "read-only" as const, approvalPolicy: "on-request" as const },
  ])("describes discovery only when launch permissions restrict calls: %j", ({ mode, sandboxMode, approvalPolicy }) => {
    const launch = buildAgentLaunch({ agent: "claude", cwd: "/owner/projects/app", runtimeHome: "/owner",
      prompt: "Inspect", matrixCustomMcp: true, matrixCustomMcpScope: "call", mode, approvalPolicy,
      sandbox: { enabled: true, mode: sandboxMode, writableRoots: ["/owner/projects/app"] } });
    const prompt = launch.args[launch.args.indexOf("--append-system-prompt") + 1]!;
    expect(prompt).toContain("discovery only");
    expect(prompt).not.toContain("broker owns approval");
    const mcpConfig = JSON.parse(launch.args[launch.args.indexOf("--mcp-config") + 1]!);
    expect(mcpConfig.mcpServers["matrix-integrations"].args).toContain("--tool-surface=custom-mcp-discovery");
  });

  it("describes broker-mediated calls under supervised default permissions without auto-approving them", () => {
    const launch = buildAgentLaunch({ agent: "claude", cwd: "/owner/projects/app", runtimeHome: "/owner",
      prompt: "Use the connected service", matrixCustomMcp: true, matrixCustomMcpScope: "call",
      claudePermissionMode: "default", approvalPolicy: "on-request",
      sandbox: { enabled: true, mode: "workspace-write", writableRoots: ["/owner/projects/app"] } });
    const prompt = launch.args[launch.args.indexOf("--append-system-prompt") + 1]!;
    expect(prompt).toContain("broker owns approval");
    expect(prompt).not.toContain("discovery only");
    expect(launch.args[launch.args.indexOf("--permission-mode") + 1]).toBe("default");
    const settings = JSON.parse(launch.args[launch.args.indexOf("--settings") + 1]!);
    expect(settings.permissions.allow).toContain("mcp__matrix-integrations__list_custom_mcp_servers");
    expect(settings.permissions.allow).not.toContain("mcp__matrix-integrations__call_custom_mcp_tool");
    expect(settings.sandbox.enabled).toBe(true);
    expect(settings.sandbox.allowUnsandboxedCommands).toBe(false);
    const mcpConfig = JSON.parse(launch.args[launch.args.indexOf("--mcp-config") + 1]!);
    expect(mcpConfig.mcpServers["matrix-integrations"].args).toContain("--tool-surface=custom-mcp-call");
  });

  it("keeps the restricted preview Drive launch on its own MCP surface", () => {
    const launch = buildAgentLaunch({ agent: "claude", cwd: "/owner", runtimeHome: "/owner",
      matrixCustomMcp: true, matrixCustomMcpScope: "preview_drive_call",
      claudePermissionMode: "default", approvalPolicy: "on-request",
      sandbox: { enabled: true, mode: "workspace-write", writableRoots: ["/owner"] } });
    const prompt = launch.args[launch.args.indexOf("--append-system-prompt") + 1]!;
    const config = JSON.parse(launch.args[launch.args.indexOf("--mcp-config") + 1]!);
    expect(prompt).not.toContain("Matrix Core MCP");
    expect(config.mcpServers["matrix-integrations"].args).toContain("--tool-surface=preview-drive-call");
  });

  it("does not advertise Custom MCP wrappers without a configured MCP server", () => {
    const launch = buildAgentLaunch({ agent: "claude", cwd: "/owner/projects/app", runtimeHome: "/owner",
      sandbox: { enabled: true, mode: "workspace-write" }, approvalPolicy: "on-request" });
    const prompt = launch.args[launch.args.indexOf("--append-system-prompt") + 1]!;
    expect(prompt).toContain("Only use tools present in this run");
    expect(prompt).not.toContain("Custom MCP");
    expect(prompt).toContain("native scheduling tools");
    expect(prompt).toContain("existing Matrix routines");
  });
});
