import { Hono } from "hono";
import { expect, it, vi } from "vitest";
import { CustomMcpBroker } from "../../../packages/gateway/src/integrations/custom-mcp/broker.js";
import { createCustomMcpRoutes } from "../../../packages/gateway/src/integrations/custom-mcp/routes.js";
import { createManagedPiMcpClient } from "../../../packages/gateway/src/chat/managed-pi-mcp-client.js";
import { managedPiMcpDependencies } from "../../../packages/gateway/src/startup/managed-pi-tools.js";
import type { PlatformDb } from "../../../packages/gateway/src/platform-db.js";
import type { RemoteMcpClient } from "../../../packages/gateway/src/integrations/custom-mcp/client.js";
const id = "123e4567-e89b-42d3-a456-426614174000";
it("cancels a stalled MCP response body when the owning run stops", async () => {
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  const cancel = vi.fn(); const abort = new AbortController();
  const fetcher = vi.fn(async () => new Response(new ReadableStream({ start(controller) { stream = controller; }, cancel })));
  const client = createManagedPiMcpClient({ platformUrl: "https://platform.example.test", handle: "owner", token: "fixture", ownerId: "owner_qa", fetcher });
  const work = client.inventory("owner_qa", abort.signal);
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1)); await Promise.resolve(); abort.abort();
  const result = await Promise.race([work.then(() => null, error => error), new Promise(resolve => setTimeout(() => resolve("unsettled"), 50))]);
  try { expect(result).toBeInstanceOf(Error); expect(cancel).toHaveBeenCalledTimes(1); }
  finally { if (!cancel.mock.calls.length) stream.close(); await work.catch(() => undefined); }
});
it("uses actual broker/routes DTO and owner/policy/receipt enforcement over typed transport", async () => {
  const tool = { name: "qa_echo", description: "Synthetic echo", inputSchema: { type: "object" }, enabled: true, approval: "allow" as "allow" | "always_ask" };
  const publicServer = { id, name: "QA", url: "https://mcp.example.test/mcp", authMode: "none" as const, status: "ready", enabled: true, revision: 4, tools: [tool, { ...tool, name: "disabled", enabled: false }] };
  const row = { ...publicServer, auth_mode: "none", encrypted_credentials: null, enforcement_projection: [tool] };
  const projection = { ...publicServer, tools: [tool] };
  const consume = vi.fn(async () => true);
  const db = { listCustomMcpServers: async () => [publicServer], getCustomMcpServerForBroker: async (_id: string, owner: string) => owner === "resource_qa" ? row : null,
    consumeCustomMcpToolApproval: consume } as unknown as PlatformDb;
  const remote = vi.fn(async () => ({ content: [{ type: "text", text: "MCP_QA_OK" }] }));
  const broker = new CustomMcpBroker({ db, encryptionKey: Buffer.alloc(32), projection: { upsert: async () => {}, remove: async () => {}, read: async () => projection }, client: { callTool: remote, shutdown: async () => {} } as unknown as RemoteMcpClient });
  const routes = createCustomMcpRoutes({ broker, resolveUserId: async () => "resource_qa", resolveActorId: () => "owner_qa", allowToolCalls: true });
  const platform = new Hono(); const bodies: unknown[] = []; const headers: Headers[] = [];
  platform.use("*", async (c, next) => { headers.push(new Headers(c.req.raw.headers)); if (c.req.method === "POST") bodies.push(await c.req.raw.clone().json()); await next(); });
  platform.route("/internal/containers/owner/mcp-servers", routes);
  const client = createManagedPiMcpClient({ platformUrl: "https://platform.example.test", handle: "owner", token: "machine-fixture", ownerId: "owner_qa", fetcher: (url, init) => platform.request(url, init) });
  const signal = new AbortController().signal;
  expect(await client.inventory("owner_qa", signal)).toEqual([expect.objectContaining({ id, tools: [expect.objectContaining({ name: "qa_echo", inputSchema: { type: "object" } })] })]);
  expect(await client.describe("owner_qa", id, signal)).toMatchObject({ name: "QA" });
  const input = { serverId: id, tool: "qa_echo", arguments: { text: "QA" }, runId: "run_qa" };
  await expect(client.call("owner_qa", input, signal)).resolves.toMatchObject({ content: [{ text: "MCP_QA_OK" }] });
  expect(headers.at(-1)?.get("x-matrix-mcp-run-id")).toBe("run_qa");
  expect(headers.at(-1)?.get("authorization")).toBe("Bearer machine-fixture");
  expect(bodies.at(-1)).toEqual({ tool: "qa_echo", arguments: { text: "QA" }, approvalGranted: false });
  tool.approval = "always_ask";
  await expect(client.call("owner_qa", input, signal)).rejects.toThrow("MCP unavailable");
  await client.call("owner_qa", { ...input, approvalReceipt: "a".repeat(64) }, signal);
  expect(consume).toHaveBeenCalledWith(expect.objectContaining({ userId: "resource_qa", actorId: "owner_qa", runId: "run_qa", receipt: "a".repeat(64) }));
  row.enabled = false;
  await expect(client.call("owner_qa", input, signal)).rejects.toThrow();
  await expect(client.inventory("other", signal)).rejects.toThrow();
  expect(remote).toHaveBeenCalledTimes(2); await broker.shutdown();
});
it("reuses exact isolated Preview routing and never widens its configured owner guard", () => {
  const base = { platformUrl: "https://platform.example.test", handle: "pr-2117", token: "base", clerkOwnerId: "owner_qa", ownerId: "owner_qa" };
  expect(managedPiMcpDependencies({ ...base, ownerId: "wrong" })).toBeUndefined();
  expect(() => managedPiMcpDependencies({ ...base, env: { MATRIX_PREVIEW_RUNTIME: "true", MATRIX_HANDLE: "pr-2117", MATRIX_PREVIEW_CUSTOM_MCP_ORIGIN: "https://pr-2117---matrix-platform-preview-qa.a.run.app", MATRIX_PREVIEW_CUSTOM_MCP_TOKEN: "a".repeat(64), MATRIX_PREVIEW_CUSTOM_MCP_OWNER_ID: "real-owner" } })).toThrow();
  expect(managedPiMcpDependencies({ ...base, env: { MATRIX_PREVIEW_RUNTIME: "true", MATRIX_HANDLE: "pr-2117", MATRIX_PREVIEW_CUSTOM_MCP_ORIGIN: "https://pr-2117---matrix-platform-preview-qa.a.run.app", MATRIX_PREVIEW_CUSTOM_MCP_TOKEN: "a".repeat(64), MATRIX_PREVIEW_CUSTOM_MCP_OWNER_ID: "chat-share-preview-fixture-pr-2117" } })).toBeDefined();
});
it("uses the configured Clerk owner when the native VPS omits MATRIX_USER_ID", async () => {
  const deps = managedPiMcpDependencies({ platformUrl: "https://platform.example.test", handle: "owner", token: "fixture", clerkOwnerId: "owner_qa" });
  expect(deps).toBeDefined();
  await expect(deps!.client.inventory("foreign", new AbortController().signal)).rejects.toThrow();
});
it("caps response bytes and refuses redirects/upstream errors without leaking bodies", async () => {
  const fetcher = vi.fn(async () => new Response("upstream-secret", { status: 403 }));
  const client = createManagedPiMcpClient({ platformUrl: "https://platform.example.test", handle: "owner", token: "fixture", ownerId: "owner_qa", fetcher });
  await expect(client.inventory("owner_qa", new AbortController().signal)).rejects.toThrow("MCP unavailable");
  expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ redirect: "error", signal: expect.any(AbortSignal) });
  fetcher.mockResolvedValueOnce(new Response("x".repeat(192 * 1024 + 1)));
  await expect(client.inventory("owner_qa", new AbortController().signal)).rejects.toThrow("MCP unavailable");
});
