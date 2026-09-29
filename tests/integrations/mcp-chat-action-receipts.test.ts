import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import { createIntegrationsMcpServer } from "../../packages/integrations-mcp/dist/server.js";
import type { GatewayFetcher } from "../../packages/kernel/src/tools/integrations.js";

describe("Chat MCP action receipt transport", () => {
  it("preserves full-surface sync calls with omitted arguments", async () => {
    const fetcher = vi.fn<GatewayFetcher>(async () => ({ ok: true, status: 200,
      json: async () => ({ synced: 0 }), text: async () => "Synthetic" }));
    const server = createIntegrationsMcpServer({ toolSurface: "full", fetcher });
    const client = new Client({ name: "full-sync-compatibility", version: "1.0.0" });
    const [left, right] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([server.connect(right), client.connect(left)]);
      await client.callTool({ name: "sync_services" });
      expect(fetcher).toHaveBeenCalledOnce();
      expect(new Headers(fetcher.mock.calls[0]![1].headers).has("x-matrix-integration-approval")).toBe(false);
    } finally { await client.close(); await server.close(); }
  });
  it.each([
    { name: "call_service", args: { service: "google_drive", action: "list_files", label: "work", params: {} }, method: "POST", path: "/api/integrations/call", body: { service: "google_drive", action: "list_files", label: "work", params: {} } },
    { name: "connect_service", args: { service: "google_drive", label: "work" }, method: "POST", path: "/api/integrations/connect", body: { service: "google_drive", label: "work" } },
    { name: "sync_services", args: {}, method: "POST", path: "/api/integrations/sync", body: undefined },
    { name: "disconnect_service", args: { connection_id: "123e4567-e89b-42d3-a456-426614174000" }, method: "DELETE", path: "/api/integrations/123e4567-e89b-42d3-a456-426614174000", body: undefined },
  ])("preserves the $name receipt as a header, never in provider arguments", async ({ name, args, method, path, body }) => {
    const fetcher = vi.fn<GatewayFetcher>(async () => ({ ok: true, status: 200,
      json: async () => ({ url: "https://example.test/authorize", service: "google_drive", result: "Synthetic" }), text: async () => "Synthetic" }));
    const server = createIntegrationsMcpServer({ toolSurface: "chat-call", fetcher });
    const client = new Client({ name: "receipt-transport", version: "1.0.0" });
    const [left, right] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([server.connect(right), client.connect(left)]);
      const receipt = "a".repeat(64);
      await client.callTool({ name, arguments: { ...args, matrix_approval_receipt: receipt } });
      expect(fetcher).toHaveBeenCalledOnce();
      const [url, init] = fetcher.mock.calls[0]!;
      expect(new URL(url).pathname).toBe(path);
      expect(init.method).toBe(method);
      expect(new Headers(init.headers).get("x-matrix-integration-approval")).toBe(receipt);
      expect(init.body ? JSON.parse(init.body as string) : undefined).toEqual(body);
      expect(String(init.body ?? "")).not.toContain(receipt);
    } finally { await client.close(); await server.close(); }
  });
});
