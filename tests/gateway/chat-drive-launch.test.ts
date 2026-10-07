import { expect, it } from "vitest";
import { buildAgentLaunch } from "../../packages/gateway/src/agent-launcher.js";
import { matrixMcpConfig } from "../../packages/gateway/src/chat/matrix-mcp-launch.js";
it("adds only read-only company tools to a supervised Claude launch", () => {
    const launch = buildAgentLaunch({ agent: "claude", cwd: "/tmp/project", runtimeHome: "/tmp/home", matrixCustomMcp: true, matrixDriveContext: true, matrixCustomMcpScope: "discovery", claudePermissionMode: "default", sandbox: { enabled: true, mode: "workspace-write", writableRoots: ["/tmp/project"] } });
    const settings = JSON.parse(launch.args[launch.args.indexOf("--settings") + 1]!);
    expect(settings.permissions.allow).toEqual(expect.arrayContaining(["mcp__matrix-integrations__search_company_drive", "mcp__matrix-integrations__read_company_drive_file"]));
    expect(settings.permissions.allow).not.toContain("mcp__matrix-integrations__call_custom_mcp_tool");
    expect(JSON.parse(launch.args[launch.args.indexOf("--mcp-config") + 1]!).mcpServers["matrix-integrations"].args).toContain("--tool-surface=custom-mcp-discovery-drive");
});
it("keeps ordinary runs on their existing MCP surface", () => { expect(matrixMcpConfig("call")).not.toContain("-drive"); });
