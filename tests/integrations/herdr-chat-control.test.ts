import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { HERDR_TERMINAL_WORKSPACE_ID } from "@matrix-os/contracts/herdr-terminals";
import { Hono } from "hono";
import { afterEach, expect, it, vi } from "vitest";
import { authMiddleware } from "../../packages/gateway/src/auth.js";
import { createMatrixMcpCapabilityRegistry } from "../../packages/gateway/src/chat/matrix-mcp-launch.js";
import { HERDR_CHAT_ROUTE } from "../../packages/gateway/src/chat/herdr-chat-target.js";
import { createHerdrChatTerminalRoute } from "../../packages/gateway/src/chat/herdr-terminal-route.js";
import { createTerminalInputActivity } from "../../packages/gateway/src/terminal-agent/input-activity.js";
import { createIntegrationsMcpServer } from "../../packages/integrations-mcp/src/server.js";

afterEach(() => vi.unstubAllEnvs());

it("exposes only the selected terminal through the real MCP and authenticated Gateway, and stops on revoke", async () => {
  const owner = { type: "personal", ownerId: "user_owner" };
  const target = { chatId: "chat_owner", worktreeId: "wt_0123456789abcdef", executionRoot: "/repo/worktree",
    revision: "d".repeat(64), ref: { workspaceId: HERDR_TERMINAL_WORKSPACE_ID, tabId: "tt_" + "3".repeat(32) } };
  const registry = createMatrixMcpCapabilityRegistry({ configuredOwnerId: owner.ownerId });
  const grant = registry.issue({ owner, runId: "run_one", scope: "chat_herdr", fullAccess: true, herdr: target })!;
  const terminal = {
    check: vi.fn(async () => undefined), read: vi.fn(async () => ({ screen: "example output", history: "", lines: 0 })),
    send: vi.fn(async () => ({ sent: true as const, heldMs: 0 })),
    interrupt: vi.fn(async () => ({ pressed: "esc" as const, observed: null })), close: vi.fn(),
  };
  const bindChatTerminal = vi.fn(async () => terminal);
  const app = new Hono();
  app.use("*", authMiddleware("host-fixture", { resolveMatrixMcpRunContext: registry.resolveRunContext }));
  app.route(HERDR_CHAT_ROUTE, createHerdrChatTerminalRoute({ bindChatTerminal }, createTerminalInputActivity()));
  vi.stubEnv("MATRIX_AGENT_INTEGRATIONS_TOKEN", grant.token);
  vi.stubEnv("GATEWAY_URL", "http://127.0.0.1:4000");
  const server = createIntegrationsMcpServer({ toolSurface: "chat-herdr", fetcher: async (url, init) => app.request(url, init) });
  const client = new Client({ name: "test-herdr-chat", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(left), client.connect(right)]);
    const names = (await client.listTools()).tools.map(tool => tool.name);
    expect(names).toEqual(["terminal_list", "terminal_read", "terminal_send", "terminal_interrupt"]);
    const invoke = (name: string, args = {}) => client.callTool({ name, arguments: args });
    expect((await invoke("terminal_list")).content).toEqual([expect.objectContaining({ text: expect.stringContaining(target.ref.tabId) })]);
    expect((await invoke("terminal_read", { lines: 0 })).content).toEqual([expect.objectContaining({ text: expect.stringContaining("EXTERNAL_UNTRUSTED_CONTENT") })]);
    expect((await invoke("terminal_send", { text: "run tests" })).isError).toBeFalsy();
    expect((await invoke("terminal_interrupt")).isError).toBeFalsy();
    expect(bindChatTerminal).toHaveBeenCalledTimes(1);
    expect(bindChatTerminal).toHaveBeenCalledWith(target.ref, target.executionRoot, expect.objectContaining({ revision: target.revision }));
    const spoof = await app.request(HERDR_CHAT_ROUTE, { method: "POST",
      headers: { authorization: `Bearer ${grant.token}`, "content-type": "application/json" },
      body: JSON.stringify({ action: "send", text: "wrong ref", ref: target.ref }) });
    expect(spoof.status).toBe(400);
    grant.revoke();
    expect((await invoke("terminal_send", { text: "too late" })).isError).toBe(true);
    expect(terminal.send.mock.calls).toEqual([["run tests"]]);
  } finally { registry.close(); await client.close(); await server.close(); }
});

it("only publishes the read-only inventory tool to an unselected private Chat, using its run-scoped route", async () => {
  const owner = { type: "personal", ownerId: "user_owner" };
  const registry = createMatrixMcpCapabilityRegistry({ configuredOwnerId: owner.ownerId });
  const grant = registry.issue({ owner, runId: "run_list", scope: "chat_herdr_discovery" })!;
  const app = new Hono().use("*", authMiddleware("host-fixture", { resolveMatrixMcpRunContext: registry.resolveRunContext }));
  const discoverTerminals = vi.fn(async () => ({ machines: [
    { id: "gateway", name: "This computer", online: true, terminals: [{ id: "t1", title: "build", status: null }] },
    { id: "herdr:laptop", name: "Laptop", online: false, terminals: [] },
  ] }));
  app.route(HERDR_CHAT_ROUTE, createHerdrChatTerminalRoute({ discoverTerminals, bindChatTerminal: vi.fn() }, createTerminalInputActivity()));
  vi.stubEnv("MATRIX_AGENT_INTEGRATIONS_TOKEN", grant.token);
  vi.stubEnv("GATEWAY_URL", "http://127.0.0.1:4000");
  const server = createIntegrationsMcpServer({ toolSurface: "chat-herdr-discovery", fetcher: async (url, init) => app.request(url, init) });
  const client = new Client({ name: "test-inventory", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(left), client.connect(right)]);
    expect((await client.listTools()).tools.map(t => t.name)).toEqual(["terminal_discover"]);
    const invoke = (args: Record<string, unknown>) => client.callTool({ name: "terminal_discover", arguments: args });
    const text = (result: Awaited<ReturnType<typeof invoke>>) => JSON.stringify(result.content);
    expect(text(await invoke({}))).toContain("gateway/t1");
    expect(text(await invoke({ machine: "herdr:laptop" }))).toContain("offline");
    expect(text(await invoke({ machine: "herdr:missing" }))).toContain("not_listed");
    expect((await invoke({ machine: "../route" })).isError).toBe(true);
    grant.revoke();
    expect((await invoke({})).isError).toBe(true);
    expect(discoverTerminals).toHaveBeenCalledTimes(3);
  } finally { registry.close(); await client.close(); await server.close(); }
});
