import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildAgentLaunch } from "../../packages/gateway/src/agent-launcher.js";
import { createMatrixMcpCapabilityRegistry, MATRIX_CORE_MCP_CALL_TOOLS, MATRIX_CORE_MCP_DISCOVERY_TOOLS } from "../../packages/gateway/src/chat/matrix-mcp-launch.js";
import { buildOpenCodeRunConfiguration, prepareOpenCodeRunEnvironment } from "../../packages/gateway/src/coding-agents/managed-harness-process-config.js";

// Spec 2691 layer 4 checkpoint: each harness launch config contains the scoped
// Matrix Core server. Fault detected: a harness launches without the server,
// without the scoped-capability requirement (machine-bearer fallback), or with
// a Core tool surface the run's permission mode does not allow.
const TOKEN = "c".repeat(64);
const LAUNCHER = "/opt/matrix/bin/matrix-integrations-mcp";
const sandbox = { enabled: true, mode: "workspace-write" as const, writableRoots: ["/safe/project"] };

function claudeSettings(launch: ReturnType<typeof buildAgentLaunch>) {
  return JSON.parse(launch.args[launch.args.indexOf("--settings") + 1]!);
}

function codexOverrides(args: string[]): string[] {
  return args.flatMap((value, index) => args[index - 1] === "-c" && value.startsWith("mcp_servers.") ? [value] : []);
}

describe("Matrix Core MCP harness parity launch configs", () => {
  it("gives Claude Code the scoped server labelled claude_code and allows Core discovery", () => {
    const launch = buildAgentLaunch({ agent: "claude", cwd: "/safe/project", runtimeHome: "/safe/home", matrixCustomMcp: true,
      matrixCustomMcpScope: "chat_discovery", claudePermissionMode: "default", sandbox });
    const server = JSON.parse(launch.args[launch.args.indexOf("--mcp-config") + 1]!).mcpServers["matrix-integrations"];
    expect(server.command).toBe(LAUNCHER);
    expect(server.args).toEqual(["--require-scoped-capability", "--tool-surface=chat-discovery", "--harness=claude_code"]);
    expect(claudeSettings(launch).permissions.allow).toEqual(expect.arrayContaining([...MATRIX_CORE_MCP_DISCOVERY_TOOLS]));
    // Default permission mode prompts for call_tool so the approval hook sees it.
    expect(claudeSettings(launch).permissions.allow).not.toContain("mcp__matrix-integrations__call_tool");
  });

  it("allows Claude Code call_tool only where Custom MCP calls are already auto-approved", () => {
    const launch = buildAgentLaunch({ agent: "claude", cwd: "/safe/project", runtimeHome: "/safe/home", matrixCustomMcp: true,
      matrixCustomMcpScope: "chat_call", claudePermissionMode: "dontAsk", approvalPolicy: "on-request", sandbox });
    expect(claudeSettings(launch).permissions.allow).toEqual(expect.arrayContaining([...MATRIX_CORE_MCP_DISCOVERY_TOOLS, ...MATRIX_CORE_MCP_CALL_TOOLS]));
  });

  it.each([
    ["call", "workspace-write", "--tool-surface=custom-mcp-call"],
    ["discovery", "read-only", "--tool-surface=custom-mcp-discovery"],
  ] as const)("gives Codex the scoped %s server through -c mcp_servers overrides", (scope, mode, surface) => {
    const launch = buildAgentLaunch({ agent: "codex", cwd: "/safe/project", runtimeHome: "/safe/home", prompt: "hello",
      sandbox: { enabled: true, mode }, providerEventPath: "/safe/home/system/events.jsonl", matrixCoreMcp: { scope, token: TOKEN } });
    expect(codexOverrides(launch.args)).toEqual([
      `mcp_servers.matrix-integrations.command="${LAUNCHER}"`,
      `mcp_servers.matrix-integrations.args=["--require-scoped-capability","${surface}","--harness=codex"]`,
      'mcp_servers.matrix-integrations.env_vars=["MATRIX_AGENT_INTEGRATIONS_TOKEN"]',
    ]);
    expect(launch.env).toMatchObject({ MATRIX_AGENT_INTEGRATIONS_TOKEN: TOKEN, MATRIX_MCP_HARNESS: "codex" });
  });

  it("puts the Codex overrides before the exec subcommand on the direct CLI path", () => {
    const launch = buildAgentLaunch({ agent: "codex", cwd: "/safe/project", runtimeHome: "/safe/home", prompt: "hello",
      sandbox: { enabled: true, mode: "workspace-write" }, matrixCoreMcp: { scope: "call", token: TOKEN } });
    expect(codexOverrides(launch.args)).toHaveLength(3);
    expect(launch.args.lastIndexOf("-c")).toBeLessThan(launch.args.indexOf("exec"));
  });

  it("rejects a malformed run capability instead of launching Codex without scope", () => {
    expect(() => buildAgentLaunch({ agent: "codex", cwd: "/safe/project", runtimeHome: "/safe/home", prompt: "hello",
      sandbox: { enabled: true, mode: "workspace-write" }, matrixCoreMcp: { scope: "call", token: "machine-bearer" } })).toThrow();
  });

  it.runIf(spawnSync("codex", ["--version"], { encoding: "utf8" }).status === 0)("is accepted by the installed Codex CLI", async () => {
    const home = await mkdtemp(join(tmpdir(), "codex-core-mcp-"));
    try {
      const launch = buildAgentLaunch({ agent: "codex", cwd: "/safe/project", runtimeHome: "/safe/home", prompt: "hello",
        sandbox: { enabled: true, mode: "workspace-write" }, matrixCoreMcp: { scope: "call", token: TOKEN } });
      const overrides = codexOverrides(launch.args).flatMap(value => ["-c", value]);
      const listed = spawnSync("codex", [...overrides, "mcp", "list", "--json"], { encoding: "utf8", env: { PATH: process.env.PATH ?? "", CODEX_HOME: home }, timeout: 20_000 });
      expect(listed.status).toBe(0);
      const server = JSON.parse(listed.stdout).find((entry: { name: string }) => entry.name === "matrix-integrations");
      expect(server.transport).toMatchObject({ type: "stdio", command: LAUNCHER, env_vars: ["MATRIX_AGENT_INTEGRATIONS_TOKEN"],
        args: ["--require-scoped-capability", "--tool-surface=custom-mcp-call", "--harness=codex"] });
    } finally { await rm(home, { recursive: true, force: true }); }
  });

  it("gives OpenCode a local scoped server and permits only the Core tools", () => {
    const config = JSON.parse(buildOpenCodeRunConfiguration(undefined, { scope: "call" }));
    expect(config.mcp["matrix-integrations"]).toEqual({
      type: "local",
      command: [LAUNCHER, "--require-scoped-capability", "--tool-surface=custom-mcp-call", "--harness=opencode"],
      environment: { MATRIX_AGENT_INTEGRATIONS_TOKEN: "{env:MATRIX_AGENT_INTEGRATIONS_TOKEN}" },
    });
    expect(config.permission["*"]).toBe("deny");
    for (const tool of ["list_services", "search_tools", "describe_tool", "call_tool", "get_approval"]) {
      expect(config.permission[`matrix-integrations_${tool}`]).toBe("allow");
    }
    expect(config.permission["matrix-integrations_*"]).toBeUndefined();
    expect(JSON.parse(buildOpenCodeRunConfiguration(undefined)).mcp).toBeUndefined();
  });

  it("passes the OpenCode run capability only through the child environment", () => {
    const env = prepareOpenCodeRunEnvironment({ homePath: "/safe/home", coreMcp: { scope: "discovery", token: TOKEN } });
    expect(env).toMatchObject({ MATRIX_AGENT_INTEGRATIONS_TOKEN: TOKEN, MATRIX_MCP_HARNESS: "opencode" });
    expect(env.OPENCODE_CONFIG_CONTENT).not.toContain(TOKEN);
    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT!).permission["matrix-integrations_call_tool"]).toBeUndefined();
  });

  it("issues Codex/OpenCode run capabilities that reach only the Core and Custom MCP broker paths", () => {
    const owner = { type: "personal" as const, ownerId: "owner_core_parity" };
    const registry = createMatrixMcpCapabilityRegistry({ configuredOwnerId: owner.ownerId });
    const grant = registry.issue({ owner, runId: "codex-session-1", scope: "call" })!;
    expect(registry.resolveRunContext(grant.token, "POST", "/api/mcp-servers/core/call")).toMatchObject({ runId: "codex-session-1", scope: "call" });
    expect(registry.resolve(grant.token, "POST", "/api/mcp-approvals/123e4567-e89b-42d3-a456-426614174000")).toBeNull();
    expect(registry.resolve(grant.token, "GET", "/api/files")).toBeNull();
    registry.close();
  });
});
