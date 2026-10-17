import { SHARED_BROWSER_ACTION_DEADLINE_MS } from "@matrix-os/contracts";
import { expect, it } from "vitest";
import { buildAgentLaunch } from "../../packages/gateway/src/agent-launcher.js";
import { configureClaudeSharedBrowser } from "../../packages/gateway/src/chat/claude-shared-browser-launch.js";
it("merges dedicated browser MCP with existing Matrix tools, strict config and no native Chrome", () => {
  const launch = buildAgentLaunch({ agent: "claude", cwd: "/safe/project", runtimeHome: "/home/matrix/home", matrixCustomMcp: true, matrixCustomMcpScope: "chat_call", sandbox: { enabled: false, mode: "danger-full-access" }, claudePermissionMode: "bypassPermissions" });
  configureClaudeSharedBrowser(launch, { token: "a".repeat(43), mcpServer: { command: "/opt/matrix/runtime/node/bin/node", args: ["/opt/matrix/app/packages/integrations-mcp/dist/shared-browser-cli.js"], env: { MATRIX_SHARED_BROWSER_TOKEN: "a".repeat(43), MATRIX_SHARED_BROWSER_GATEWAY_PORT: "4000" } } } as never);
  const config=JSON.parse(launch.args[launch.args.indexOf("--mcp-config")+1]!);
  expect(config.mcpServers.matrix_shared_browser.timeout).toBe(390_000);
  expect(config.mcpServers.matrix_shared_browser.timeout).toBeGreaterThan(SHARED_BROWSER_ACTION_DEADLINE_MS);
  expect(Object.keys(config.mcpServers)).toEqual(["matrix-integrations", "matrix_shared_browser"]);
  expect(config.mcpServers.matrix_shared_browser.env).toEqual({ MATRIX_SHARED_BROWSER_TOKEN: "${MATRIX_SHARED_BROWSER_TOKEN}", MATRIX_SHARED_BROWSER_GATEWAY_PORT: "${MATRIX_SHARED_BROWSER_GATEWAY_PORT}" });
  expect(launch.args).toContain("--strict-mcp-config"); expect(launch.args).toContain("--no-chrome");
  expect(launch.args.join(" ")).not.toContain("a".repeat(43)); expect(launch.env.MATRIX_SHARED_BROWSER_TOKEN).toBe("a".repeat(43));
});
it("adds the only browser MCP server when integrations are unavailable", () => {
  const launch = buildAgentLaunch({ agent: "claude", cwd: "/safe", sandbox: { enabled: false, mode: "danger-full-access" }, claudePermissionMode: "bypassPermissions" });
  configureClaudeSharedBrowser(launch, { token: "b".repeat(43), mcpServer: { command: "/opt/matrix/runtime/node/bin/node", args: ["/opt/matrix/app/packages/integrations-mcp/dist/shared-browser-cli.js"], env: { MATRIX_SHARED_BROWSER_TOKEN: "b".repeat(43), MATRIX_SHARED_BROWSER_GATEWAY_PORT: "4001" } } } as never);
  expect(Object.keys(JSON.parse(launch.args[launch.args.indexOf("--mcp-config")+1]!).mcpServers)).toEqual(["matrix_shared_browser"]);
});
