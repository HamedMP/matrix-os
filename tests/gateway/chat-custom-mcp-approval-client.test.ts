import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createCustomMcpApprovalClient } from "../../packages/gateway/src/chat/custom-mcp-approval-client.js";

describe("Gateway to Platform Custom MCP approval client", () => {
  it("sends decisions only to the server-only endpoint with a machine credential", async () => {
    const platform = new Hono();
    const captured: Array<{ path: string; auth: string | undefined; body: unknown }> = [];
    platform.post("/internal/containers/owner/mcp-approvals/*", async (context) => {
      captured.push({ path: context.req.path, auth: context.req.header("authorization"),
        body: await context.req.json() });
      return context.json(context.req.path.endsWith("/prepare")
        ? { kind: "pending", approvalId: "123e4567-e89b-42d3-a456-426614174001",
          expiresAt: new Date(Date.now() + 60_000).toISOString() }
        : context.req.path.includes("/decisions/") ? { receipt: "a".repeat(64) }
          : context.req.path.endsWith("/revoke") ? { revoked: true }
            : context.req.path.endsWith("/clear") ? { generation: 2, invalidated: 1 }
              : { registered: true, generation: 1 });
    });
    const fetcher = vi.fn((url: string, init: RequestInit) => platform.request(url, init));
    const client = createCustomMcpApprovalClient({
      platformUrl: "https://platform.example.test", handle: "owner", token: "machine-token", fetcher,
    });
    await expect(client.registerRun("run_owner")).resolves.toEqual({ generation: 1 });
    await expect(client.prepare("run_owner", {
      generation: 1, nativeRequestId: "native_1", serverId: "123e4567-e89b-42d3-a456-426614174000",
      tool: "publish", arguments: { content: "fixture" },
    })).resolves.toMatchObject({ kind: "pending" });
    await expect(client.decide("run_owner", "123e4567-e89b-42d3-a456-426614174001", "approve", {
      chatId: "chat_owner", clientRequestId: "req_1", platformApprovalProof: "signed-proof-fixture",
    }))
      .resolves.toEqual({ receipt: "a".repeat(64) });
    await expect(client.revokeRun("run_owner")).resolves.toBe(true);
    await expect(client.clearRunApprovals("run_owner", 1)).resolves.toEqual({ generation: 2, invalidated: 1 });
    expect(captured).toHaveLength(5);
    expect(captured.every(({ path, auth }) => path.includes("/mcp-approvals/")
      && auth === "Bearer machine-token")).toBe(true);
    expect(JSON.stringify(captured)).not.toContain("approvalGranted");
    expect(captured[2]!.body).toEqual({ decision: "approve", chatId: "chat_owner", clientRequestId: "req_1" });
    expect(fetcher.mock.calls[2]?.[1]?.headers).toMatchObject({
      "x-matrix-custom-mcp-approval-proof": "signed-proof-fixture",
    });
  });
});
