import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { Hono } from "hono";
import { expect, it, vi } from "vitest";
import {
  createBotIntegrationClient,
  createPlatformIntegrationTransport,
} from "../../packages/gateway/src/bots/integration-client.js";
import { createHostedBotsDriveApproval } from "../../packages/gateway/src/hosted-bots/drive-approval.js";
import { bindHostedBotsDriveSocket } from "../../packages/gateway/src/hosted-bots/drive-approval-runtime.js";
// @ts-expect-error The preview ships this isolated Node script as-is.
import { integrationToolReply } from "../../scripts/openmausbot/matrix-drive-mcp.mjs";

it("carries the same integration read from MCP through owner review and signed Platform dispatch", async () => {
  const input = { service: "github", action: "list_prs", params: { repo: "HamedMP/matrix-os", per_page: 1 } };
  const ownerId = "user_preview_owner";
  const account = { id: "github-fixture", label: "Test GitHub" };
  const result = [{ number: 42, state: "open" }];
  const base = "https://platform.example/internal/containers/pv-3239-1234abcd/integrations";
  const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(url, init);
    expect(request.headers.get("authorization")).toBe("Bearer test-machine-token");
    expect(request.headers.get("x-platform-user-id")).toBe(ownerId);
    expect(request.headers.get("x-platform-verified")).toBeTruthy();
    if (request.url === base) {
      return Response.json([{ id: account.id, account_label: account.label, service: "github", status: "active" }]);
    }
    expect(request.headers.get("x-matrix-integration-read-scope")).toBe("read");
    if (request.url === `${base}/agent-catalog`) {
      return Response.json([{ id: "github", actions: { list_prs: { description: "List pull requests", risk: "read", params: {} } } }]);
    }
    expect(request.url).toBe(`${base}/read-call`);
    expect(request.method).toBe("POST");
    expect(await request.json()).toEqual({ ...input, connectionId: account.id, label: account.label });
    return Response.json({ data: result });
  });
  const broker = createHostedBotsDriveApproval({
    admitted: true, ownerId, isOwner: (c) => c.req.header("x-test-owner") === ownerId,
    integration: createBotIntegrationClient(createPlatformIntegrationTransport({
      baseUrl: base, machineToken: "test-machine-token", fetchImpl,
    })),
  });
  const path = "/api/hosted-bots/integrations";
  const owner = new Hono();
  owner.route(path, broker.integrationOwnerRoutes);
  const headers = { "x-test-owner": ownerId, "content-type": "application/json" };
  const directory = await mkdtemp("/tmp/matrix-integrations-");
  const socket = join(directory, "drive.sock");
  let close: (() => Promise<void>) | undefined;
  try {
    close = await bindHostedBotsDriveSocket(socket, broker.guestRoutes);
    const tool = integrationToolReply(input, socket);
    const id = await vi.waitFor(async () => {
      const snapshot = await (await owner.request(path, { headers })).json();
      expect(snapshot.requests).toEqual([{
        ...input, id: expect.any(String), expiresAt: expect.any(Number), status: "pending",
      }]);
      expect(snapshot.accounts).toEqual([]);
      return snapshot.requests[0].id as string;
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    const review = await (await owner.request(`${path}?includeAccounts=1`, { headers })).json();
    expect(review.accounts).toEqual([{ ...account, service: "github" }]);
    expect((await owner.request(`${path}/${id}/decision`, {
      method: "POST", headers, body: JSON.stringify({ decision: "allow", accountId: account.id }),
    })).status).toBe(202);
    expect(await tool).toEqual({ content: [{ type: "text", text: JSON.stringify({ data: result }) }] });
    expect(fetchImpl.mock.calls.filter(([url]) => url === `${base}/read-call`)).toHaveLength(1);
  } finally {
    broker.close();
    await close?.();
    await rm(directory, { force: true, recursive: true });
  }
});
