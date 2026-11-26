import { Hono } from "hono";
import { expect, it, vi } from "vitest";
import { createCodexMcpRunScope } from "../../packages/gateway/src/chat/codex-mcp-run-scope.js";
import { createHerdrChatTerminalRoute } from "../../packages/gateway/src/chat/herdr-terminal-route.js";
import { createMatrixMcpCapabilityRegistry, MATRIX_MCP_RUN_CONTEXT_KEY } from "../../packages/gateway/src/chat/matrix-mcp-launch.js";
import type { CanonicalProviderRunInput } from "../../packages/gateway/src/chat/provider-adapter.js";
import { createTerminalInputActivity } from "../../packages/gateway/src/terminal-agent/input-activity.js";

it("lets the owner page and search terminals without granting access to their screens or input", async () => {
  const registry = createMatrixMcpCapabilityRegistry({ configuredOwnerId: "alice" });
  const scope = createCodexMcpRunScope({ issuer: registry, gatewayPort: 4000 });
  const session = scope.open({
    ownerSubmittedHerdrDiscovery: true, owner: { type: "personal", ownerId: "alice" },
    chatId: "chat_private", runId: "run_question", interactionMode: "default", permissionMode: "supervised",
    parts: [{ type: "text", text: "有哪些在线的电脑？" }], worktreeId: "wt_7777777777777777",
    executionRoot: "/worktree", signal: new AbortController().signal,
  } as CanonicalProviderRunInput);
  expect(session?.lease.discoveryOnly).toBe(true);
  const token = session!.lease.token;
  const path = "/api/chat/herdr-terminal";
  const grant = registry.resolveRunContext(token, "POST", path);
  expect(grant?.scope).toBe("chat_herdr_discovery");

  const terminals = Array.from({ length: 15 }, (_, i) => ({
    id: "t" + (i + 1), title: i === 11 ? "builder" : "shell", status: "idle" as const,
  }));
  const adapter = {
    discoverTerminals: async () => ({ machines: [
      ...Array.from({ length: 7 }, (_, i) => ({ id: "herdr:old" + i, name: "old" + i, online: false, terminals: [] })),
      { id: "gateway", name: "This computer", online: true, terminals },
      { id: "herdr:online", name: "Online", online: true, terminals: [] },
    ] }),
    bindChatTerminal: vi.fn(),
  };
  const app = new Hono()
    .use("*", async (c, next) => { c.set(MATRIX_MCP_RUN_CONTEXT_KEY as never, grant as never); await next(); })
    .route(path, createHerdrChatTerminalRoute(adapter, createTerminalInputActivity()));
  const post = (body: object) => app.request(path, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const discover = async (params = {}) => (await post({ action: "discover", ...params })).json();
  try {
    const overview = await discover();
    expect(overview.machines[0]).toMatchObject({ id: "gateway", terminalCount: 15 });
    expect(overview.machines[0].terminals).toBeUndefined();
    expect(overview.machines[1]).toMatchObject({ id: "herdr:online", terminalCount: 0 });
    expect(overview.machines).toHaveLength(5);
    expect(overview.nextOffset).toBe(5);
    const first = await discover({ machine: "gateway" });
    expect(first.terminals).toHaveLength(5);
    expect(first.nextOffset).toBe(5);
    const next = await discover({ machine: "gateway", offset: first.nextOffset });
    expect(next.terminals[0].address).not.toBe(first.terminals[0].address);
    const filtered = await discover({ machine: "gateway", query: "BUILD" });
    expect(filtered.terminals).toMatchObject([{ address: "gateway/t12", title: "builder" }]);
    expect((await discover({ query: "builder" })).terminals).toEqual(filtered.terminals);
    for (const action of ["read", "send", "interrupt", "list"]) {
      expect((await post({ action })).status).toBe(403);
    }
    expect(adapter.bindChatTerminal).not.toHaveBeenCalled();
    session!.close();
    expect(registry.resolve(token, "POST", path)).toBeNull();
    expect((await post({ action: "discover" })).status).toBe(403);
  } finally {
    registry.close();
  }
});
