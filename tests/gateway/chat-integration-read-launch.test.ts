import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { authMiddleware } from "../../packages/gateway/src/auth.js";
import { createMatrixMcpCapabilityRegistry, matrixMcpConfig } from "../../packages/gateway/src/chat/matrix-mcp-launch.js";
import { buildAgentLaunch } from "../../packages/gateway/src/agent-launcher.js";
import { createClaudeChatProviderAdapter } from "../../packages/gateway/src/chat/claude-provider-adapter.js";
import { isScopedReadCatalogRequest, projectIntegrationCatalog } from "../../packages/gateway/src/integrations/catalog-projection.js";
import { proxyIntegrationRequest } from "../../packages/gateway/src/integrations/platform-proxy.js";

const owner = { type: "personal" as const, ownerId: "owner_read_chat" };
const readTools = ["list_integration_inventory", "describe_service", "call_service"].map(name => `mcp__matrix-integrations__${name}`);

describe("Claude built-in integration reads", () => {
  it.each(["call", "discovery"] as const)("adds only exact read broker paths to opted-in %s scopes", scope => {
    let now = 0;
    const registry = createMatrixMcpCapabilityRegistry({ configuredOwnerId: owner.ownerId, now: () => now });
    const old = registry.issue({ owner, runId: "run_old", scope })!;
    expect(registry.resolve(old.token, "GET", "/api/integrations")).toBeNull();
    const grant = registry.issue({ owner, runId: "run_read", scope, integrationRead: true })!;
    for (const [method, path] of [["GET", "/api/integrations"], ["GET", "/api/integrations/agent-catalog"], ["POST", "/api/integrations/read-call"]]) {
      expect(registry.resolveRunContext(grant.token, method!, path!)).toEqual({ actorId: owner.ownerId, runId: "run_read", scope, integrationRead: true });
    }
    for (const [method, path] of [["POST", "/api/integrations/call"], ["POST", "/api/integrations/connect"], ["POST", "/api/integrations/sync"], ["DELETE", "/api/integrations/connections/abc"], ["POST", "/api/integrations/read-call/extra"], ["GET", "/api/files"]]) {
      expect(registry.resolve(grant.token, method!, path!)).toBeNull();
    }
    expect(registry.resolve(grant.token, "POST", "/api/mcp-servers/123e4567-e89b-42d3-a456-426614174000/call")).toBe(scope === "call" ? owner.ownerId : null);
    grant.revoke();
    expect(registry.resolve(grant.token, "GET", "/api/integrations")).toBeNull();
    const expiring = registry.issue({ owner, runId: "run_expiring", scope, integrationRead: true })!;
    now = 35 * 60_000;
    expect(registry.resolve(expiring.token, "GET", "/api/integrations")).toBeNull();
    registry.close();
  });

  it("allows opt-in only for the configured owner and preserves no-flag launch surfaces", () => {
    const registry = createMatrixMcpCapabilityRegistry({ configuredOwnerId: owner.ownerId });
    expect(registry.issue({ owner: { type: "personal", ownerId: "foreign_owner" }, runId: "run_wrong", scope: "call", integrationRead: true })).toBeNull();
    expect(registry.issue({ owner, runId: "run_invalid", scope: "call", integrationRead: "true" as never })).toBeNull();
    expect(JSON.parse(matrixMcpConfig("call")).mcpServers["matrix-integrations"].args).toContain("--tool-surface=custom-mcp-call");
    registry.close();
  });

  it.each([false, true])("adds read-only tools to the explicit launch with company Drive=%s", driveContext => {
    const launch = buildAgentLaunch({ agent: "claude", cwd: "/safe/project", runtimeHome: "/safe/home", matrixCustomMcp: true, matrixIntegrationRead: true, matrixDriveContext: driveContext, matrixCustomMcpScope: "discovery", claudePermissionMode: "default", sandbox: { enabled: true, mode: "workspace-write", writableRoots: ["/safe/project"] } });
    const settings = JSON.parse(launch.args[launch.args.indexOf("--settings") + 1]!);
    expect(settings.permissions.allow).toEqual(expect.arrayContaining(readTools));
    expect(settings.permissions.allow).not.toContain("mcp__matrix-integrations__call_custom_mcp_tool");
    const config = JSON.parse(launch.args[launch.args.indexOf("--mcp-config") + 1]!);
    expect(config.mcpServers["matrix-integrations"].args).toContain(`--tool-surface=custom-mcp-discovery-integrations${driveContext ? "-drive" : ""}`);
    const guidance = launch.args[launch.args.indexOf("--append-system-prompt") + 1]!;
    expect(guidance).toContain("list_integration_inventory");
    expect(guidance).toContain("exact account label");
  });

  it("projects only registry-verified integrationRead provenance through the Platform proxy", async () => {
    const registry = createMatrixMcpCapabilityRegistry({ configuredOwnerId: owner.ownerId });
    const grant = registry.issue({ owner, runId: "run_proxy", scope: "call", integrationRead: true })!;
    const app = new Hono();
    app.use("*", authMiddleware("machine-secret", { resolveMatrixMcpRunContext: registry.resolveRunContext }));
    const fetcher = vi.fn(async (_url, init) => Response.json({ marker: new Headers(init?.headers).get("x-matrix-integration-read-scope") }));
    app.get("/api/integrations/agent-catalog", c => {
      expect(isScopedReadCatalogRequest(c)).toBe(true);
      return proxyIntegrationRequest(c, { targetBase: "https://platform.test/integrations", machineToken: "machine-secret", fetcher });
    });
    const response = await app.request("/api/integrations/agent-catalog", { headers: { authorization: `Bearer ${grant.token}`, "x-matrix-integration-read-scope": "false" } });
    expect(await response.json()).toEqual({ marker: "read" });
    registry.close();
  });

  it("keeps preset catalog intersection read-only", async () => {
    const services = await projectIntegrationCatalog({ services: [{ id: "fixture", name: "Fixture", connectorKind: "mcp_preset", actions: { read: { risk: "read", description: "Read", params: {} }, write: { risk: "write", description: "Write", params: {} } } }] as never, uid: owner.ownerId, capabilityIdentityFailed: false, authoritative: true, readOnly: true, presetBroker: { listAvailableActions: async () => ["read", "write"] }, logoUrl: () => "" });
    expect(Object.keys(services[0]!.actions)).toEqual(["read"]);
  });

  it.each(["default", "review"])("wires owner reads into fresh and resumed %s Chat while keeping credentials isolated", async mode => {
    const registry = createMatrixMcpCapabilityRegistry({ configuredOwnerId: owner.ownerId });
    const seen: Array<{ token: string; args: string[] }> = [];
    const spawnFn = vi.fn((_command, args, opts) => {
      const token = opts.env.MATRIX_AGENT_INTEGRATIONS_TOKEN;
      seen.push({ token, args });
      expect(opts.env.MATRIX_AUTH_TOKEN).toBeUndefined();
      expect(registry.resolve(token, "POST", "/api/integrations/read-call")).toBe(owner.ownerId);
      expect(registry.resolve(token, "POST", "/api/integrations/call")).toBeNull();
      const child = new EventEmitter();
      const stdout = new EventEmitter();
      queueMicrotask(() => { stdout.emit("data", Buffer.from(`${JSON.stringify({ type: "result", subtype: "success", result: "done", session_id: "session_read_chat" })}\n`)); child.emit("exit", 0, null); });
      return Object.assign(child, { stdout, stderr: new EventEmitter(), kill: vi.fn(), stdin: { write: vi.fn((_line, callback) => { callback?.(); return true; }) } });
    });
    const adapter = createClaudeChatProviderAdapter({ homePath: "/safe/home", spawnFn, resolveCredentialEnv: async () => ({ MATRIX_AUTH_TOKEN: "must-stay-host-side" }), matrixMcpCapabilityIssuer: registry });
    const input = { owner, chatId: "chat_read", turnId: "turn_read", runId: "run_fresh", prompt: "Read Drive", parts: [{ type: "text" as const, text: "Read Drive" }], selection: { instanceId: "claude_code_default", model: "claude-haiku-4-5" }, interactionMode: mode, permissionMode: "supervised", signal: new AbortController().signal };
    for await (const _ of adapter.start(input)) { /* Drain. */ }
    for await (const _ of adapter.resume!({ ...input, runId: "run_resumed", resumeState: { sessionId: "session_read_chat" } })) { /* Drain. */ }
    expect(seen).toHaveLength(2);
    for (const { args, token } of seen) {
      expect(JSON.parse(args[args.indexOf("--settings") + 1]!).permissions.allow).toEqual(expect.arrayContaining(readTools));
      expect(JSON.parse(args[args.indexOf("--mcp-config") + 1]!).mcpServers["matrix-integrations"].args.join(" ")).toContain("-integrations");
      expect(registry.resolve(token, "GET", "/api/integrations")).toBeNull();
    }
    registry.close();
  });
});
