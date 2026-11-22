import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { expect, it, vi } from "vitest";
import { createSharedBrowserMcpServer } from "../../packages/integrations-mcp/src/shared-browser.js";

it("preserves verified collection manifests and explicit handoff instructions through native MCP",async()=>{
  const artifact={documentId:"INV-1",path:"data/browser-artifacts/INV-1-"+"a".repeat(64)+".pdf",size:1000,sha256:"a".repeat(64),sourceUrl:"https://example.com/invoice.pdf",retrievedAt:new Date().toISOString(),original:true};
  const collectionManifest="data/browser-artifacts/collection-12345678-1234-1234-1234-123456789abc.json";
  const fetcher=vi.fn().mockResolvedValueOnce(Response.json({success:true,artifact,collectionManifest}))
    .mockResolvedValueOnce(Response.json({success:false,handoffRequested:true,elements:[],content:"The owner must sign in using Take over."}));
  const server=createSharedBrowserMcpServer({gatewayPort:4000,token:"a".repeat(43),fetcher});const client=new Client({name:"native-collection-handoff",version:"1"});
  const[a,b]=InMemoryTransport.createLinkedPair();await Promise.all([server.connect(b),client.connect(a)]);
  try{
    const download=await client.callTool({name:"shared_browser",arguments:{action:"download",documentId:"INV-1",ref:"r1",observationId:"obs"}});
    expect(download.isError).not.toBe(true);expect(JSON.stringify(download)).toContain(collectionManifest);
    const handoff=await client.callTool({name:"shared_browser",arguments:{action:"snapshot"}});
    expect(handoff.isError).not.toBe(true);expect(JSON.stringify(handoff)).toContain("Take over");
  }finally{await client.close();await server.close();}
});

it("advertises and invokes one exact gated tool through real MCP, without model endpoints or run identity", async () => {
  const fetcher = vi.fn(async () => Response.json({ success: true, observationId: "obs_1", elements: [{ ref: "ref_1", role: "link", name: "Invoice" }] }));
  const server = createSharedBrowserMcpServer({ gatewayPort: 4000, token: "a".repeat(43), fetcher });
  const client = new Client({ name: "native-browser-fixture", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const tools = await client.listTools(); expect(tools.tools.map(tool => tool.name)).toEqual(["shared_browser"]);
    const result = await client.callTool({ name: "shared_browser", arguments: { action: "snapshot" } });
    expect(result.isError).not.toBe(true);
    expect(JSON.stringify(result)).toContain("obs_1");
    expect(fetcher).toHaveBeenCalledWith("http://127.0.0.1:4000/apps/browser-lab/api/agent-action", expect.objectContaining({ method: "POST", redirect: "error", body: '{"action":"snapshot"}', signal: expect.any(AbortSignal) }));
    const invalid = await client.callTool({ name: "shared_browser", arguments: { action: "snapshot", ownerId: "other", cdpUrl: "http://localhost:9222" } });
    expect(invalid.isError).toBe(true); expect(fetcher).toHaveBeenCalledOnce();
  } finally { await client.close(); await server.close(); }
});
it("redacts broker errors, invalid results and refused capability rather than leaking local paths or secrets", async () => {
  const server = createSharedBrowserMcpServer({ gatewayPort: 4000, token: "a".repeat(43), fetcher: async () => new Response("private /home/token database password", { status: 403 }) });
  const client = new Client({ name: "native-browser-refusal", version: "1" });
  const [a,b] = InMemoryTransport.createLinkedPair(); await Promise.all([server.connect(b), client.connect(a)]);
  try { const result = await client.callTool({ name: "shared_browser", arguments: { action: "status" } });
    expect(result.isError).toBe(true); expect(JSON.stringify(result)).not.toMatch(/private|password|database|\/home/);
  } finally { await client.close(); await server.close(); }
});

it.each([
  {
    failure: "a broker conflict",
    respond: async () => Response.json({
      error: "The browser action is unavailable. Its effect must be checked before retrying.",
    }, { status: 409 }),
  },
  {
    failure: "a transport rejection",
    respond: async () => { throw new TypeError("socket closed"); },
  },
])("reports an unconfirmed click without inferring an owner handoff after $failure", async ({ respond }) => {
  const fetcher = vi.fn(respond);
  const server = createSharedBrowserMcpServer({ gatewayPort: 4000, token: "a".repeat(43), fetcher });
  const client = new Client({ name: "native-browser-uncertain-action", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const result = await client.callTool({
      name: "shared_browser",
      arguments: { action: "click", observationId: "obs_1", ref: "ref_1" },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).not.toMatch(/owner paused|took over|resume/i);
    expect(result.content).toEqual([{
      type: "text",
      text: "Browser action unavailable. Its effect is uncertain. Check the current Browser state and verify the outcome before continuing. Never replay an uncertain action.",
    }]);
    expect(fetcher).toHaveBeenCalledOnce();
  } finally {
    await client.close();
    await server.close();
  }
});

it("fails closed on missing bearer or invalid port before creating any browser tool", () => {
  expect(() => createSharedBrowserMcpServer({ gatewayPort: 4000, token: "" })).toThrow();
  expect(() => createSharedBrowserMcpServer({ gatewayPort: 0, token: "a".repeat(43) })).toThrow();
});

it("exposes public context in native discovery and still validates fields per action", async () => {
  const fetcher = vi.fn(async () => Response.json({ success: true, targetId: "public-tab" }));
  const server = createSharedBrowserMcpServer({ gatewayPort: 4000, token: "a".repeat(43), fetcher });
  const client = new Client({ name: "public-browser-native-discovery", version: "1" });
  const [a,b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  try {
    const [tool] = (await client.listTools()).tools;
    expect(tool?.inputSchema).toMatchObject({
      type: "object", required: ["action"], properties: { context: { const: "public" }, action: { enum: expect.arrayContaining(["tab_new", "snapshot"]) } },
    });
    const args = { action: "tab_new", context: "public", url: "https://example.com/" };
    await expect(client.callTool({ name: "shared_browser", arguments: args })).resolves.not.toHaveProperty("isError", true);
    expect(fetcher).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ body: JSON.stringify({ action: "tab_new", url: args.url, context: "public" }) }));
    const invalid = await client.callTool({ name: "shared_browser", arguments: { action: "snapshot", context: "public" } });
    expect(invalid.isError).toBe(true);
    expect(fetcher).toHaveBeenCalledOnce();
  } finally { await client.close(); await server.close(); }
});

it("reads a renewed run bearer from the private token file on every action, failing closed when it is cleared", async () => {
  const { mkdtemp, rm, writeFile, symlink } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createSharedBrowserTokenFileReader } = await import("../../packages/integrations-mcp/src/shared-browser.js");
  const dir = await mkdtemp(join(tmpdir(), "browser-token-"));
  const path = join(dir, "token");
  const fetcher = vi.fn(async () => Response.json({ success: true, observationId: "obs_1", elements: [] }));
  expect(() => createSharedBrowserTokenFileReader("relative/token")).toThrow();
  const server = createSharedBrowserMcpServer({ gatewayPort: 4000, token: createSharedBrowserTokenFileReader(path), fetcher });
  const client = new Client({ name: "native-browser-renewal", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair(); await Promise.all([server.connect(b), client.connect(a)]);
  const bearer = (index: number) => ((fetcher.mock.calls[index] as unknown[])[1] as { headers: Record<string, string> }).headers.authorization;
  try {
    expect((await client.callTool({ name: "shared_browser", arguments: { action: "status" } })).isError).toBe(true);
    await writeFile(path, "a".repeat(43), { mode: 0o600 });
    expect((await client.callTool({ name: "shared_browser", arguments: { action: "status" } })).isError).not.toBe(true);
    await writeFile(path, "b".repeat(43), { mode: 0o600 });
    expect((await client.callTool({ name: "shared_browser", arguments: { action: "status" } })).isError).not.toBe(true);
    expect([bearer(0), bearer(1)]).toEqual(["Bearer " + "a".repeat(43), "Bearer " + "b".repeat(43)]);
    await writeFile(path, "not a token", { mode: 0o600 });
    expect((await client.callTool({ name: "shared_browser", arguments: { action: "status" } })).isError).toBe(true);
    await rm(path); await writeFile(join(dir, "elsewhere"), "c".repeat(43), { mode: 0o600 }); await symlink(join(dir, "elsewhere"), path);
    expect((await client.callTool({ name: "shared_browser", arguments: { action: "status" } })).isError).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(2);
  } finally { await client.close(); await server.close(); await rm(dir, { recursive: true, force: true }); }
});
