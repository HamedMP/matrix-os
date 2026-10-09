import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { expect, it, vi } from "vitest";
import { createIntegrationsMcpServer } from "../../packages/integrations-mcp/src/server.js";
import type { GatewayFetcher } from "../../packages/kernel/src/tools/integrations.js";

it("blocks actual MCP message continuation after failed discovery until the same selected account retries successfully", async () => {
  let discoveryStatus = 403;
  const fetcher = vi.fn<GatewayFetcher>(async (_url, init) => {
    const body = JSON.parse(String(init.body));
    return Response.json(body.action === "list_channels" ? { data: [], code: "discord_access_denied" } : { data: [{ content: "Synthetic" }] },
      { status: body.action === "list_channels" ? discoveryStatus : 200 });
  });
  const server = createIntegrationsMcpServer({ fetcher });
  const client = new Client({ name: "discord-discovery-fixture", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(right), client.connect(left)]);
  const call = (action: string, label = "Work") => client.callTool({ name: "call_service", arguments: {
    service: "discord_bot", action, label, params: action === "list_channels" ? { serverId: "123456789012345678" } : { channelId: "234567890123456789" },
  } });
  try {
    expect((await call("list_channels")).isError).toBe(true);
    const blocked = await call("list_messages");
    expect(blocked.isError).toBe(true);
    expect(JSON.stringify(blocked.content)).toContain("channel discovery");
    expect(fetcher).toHaveBeenCalledTimes(1);
    discoveryStatus = 200;
    expect((await call("list_channels", "Personal")).isError).not.toBe(true);
    expect((await call("list_messages")).isError).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect((await call("list_channels")).isError).not.toBe(true);
    expect((await call("list_messages")).isError).not.toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(4);
  } finally { await client.close(); await server.close(); }
});

it("fails closed for subsequent reads when the per-run discovery capacity is exhausted", async () => {
  const { createDiscordDiscoveryGuard, callServiceHandler } = await import("../../packages/kernel/src/tools/integrations.js");
  const fetcher = vi.fn<GatewayFetcher>(async () => Response.json({ code: "discord_access_denied" }, { status: 403 }));
  const call = createDiscordDiscoveryGuard(input => callServiceHandler(input, fetcher));
  for (let index = 0; index < 128; index++) await call({ service: "discord_bot", action: "list_channels", label: `Account ${index}`, params: { serverId: "123456789012345678" } });
  const overflow = await call({ service: "discord_bot", action: "list_channels", label: "Overflow", params: { serverId: "123456789012345678" } });
  expect(overflow.isError).toBe(true);
  expect((await call({ service: "discord_bot", action: "list_messages", label: "Overflow", params: { channelId: "234567890123456789" } })).isError).toBe(true);
  expect(fetcher).toHaveBeenCalledTimes(128);
});

it("normalizes gateway labels and fences explicit/unlabeled account aliases", async () => {
  const { createDiscordDiscoveryGuard, callServiceHandler } = await import("../../packages/kernel/src/tools/integrations.js");
  const fetcher = vi.fn<GatewayFetcher>(async () => Response.json({ code: "discord_access_denied" }, { status: 403 }));
  const call = createDiscordDiscoveryGuard(input => callServiceHandler(input, fetcher));
  await call({ service: "discord_bot", action: "list_channels", label: "Work", params: { serverId: "123456789012345678" } });
  for (const label of [" Work ", undefined]) expect((await call({ service: "discord_bot", action: "list_messages", label, params: { channelId: "234567890123456789" } })).isError).toBe(true);
  expect(fetcher).toHaveBeenCalledTimes(1);
  const unlabeled = createDiscordDiscoveryGuard(input => callServiceHandler(input, fetcher));
  await unlabeled({ service: "discord_bot", action: "list_channels", params: { serverId: "123456789012345678" } });
  await unlabeled({ service: "discord_bot", action: "list_messages", label: "Work", params: { channelId: "234567890123456789" } });
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it("blocks pending discovery, preserves failures on other servers, and isolates a fresh run", async () => {
  const { createDiscordDiscoveryGuard, callServiceHandler } = await import("../../packages/kernel/src/tools/integrations.js");
  let release!: (response: Response) => void;
  let started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const pending = new Promise<Response>(resolve => { release = resolve; });
  const fetcher = vi.fn<GatewayFetcher>(async () => { started(); return pending; });
  const call = createDiscordDiscoveryGuard(input => callServiceHandler(input, fetcher));
  const discovery = call({ service: "discord_bot", action: "list_channels", label: "Work", params: { serverId: "123456789012345678" } });
  await entered;
  expect((await call({ service: "discord_bot", action: "list_channels", label: "Work", params: { serverId: "123456789012345678" } })).isError).toBe(true);
  expect((await call({ service: "discord_bot", action: "list_messages", label: "Work" })).isError).toBe(true);
  expect(fetcher).toHaveBeenCalledTimes(1);
  release(Response.json({ code: "discord_access_denied" }, { status: 403 }));
  await discovery;
  const successful = vi.fn<GatewayFetcher>(async () => Response.json({ data: [] }));
  fetcher.mockImplementation(successful);
  await call({ service: "discord_bot", action: "list_channels", label: "Work", params: { serverId: "345678901234567890" } });
  expect((await call({ service: "discord_bot", action: "list_messages", label: "Work" })).isError).toBe(true);
  const fresh = createDiscordDiscoveryGuard(input => callServiceHandler(input, successful));
  expect((await fresh({ service: "discord_bot", action: "list_messages", label: "Work" })).isError).not.toBe(true);
  expect(successful).toHaveBeenCalledTimes(2);
});

it("passes unrelated services and fences failed discovery with omitted parameters", async () => {
  const { createDiscordDiscoveryGuard } = await import("../../packages/kernel/src/tools/integrations.js");
  const delegate = vi.fn(async (input: { action: string }) => ({
    isError: input.action === "list_channels", content: [{ type: "text" as const, text: "Synthetic" }],
  }));
  const call = createDiscordDiscoveryGuard(delegate);
  expect((await call({ service: "gmail", action: "list_messages" })).isError).toBe(false);
  expect((await call({ service: "discord_bot", action: "list_servers" })).isError).toBe(false);
  expect((await call({ service: "discord", action: "list_channels" })).isError).toBe(true);
  expect((await call({ service: "discord", action: "list_messages" })).isError).toBe(true);
  expect(delegate).toHaveBeenCalledTimes(3);
});
