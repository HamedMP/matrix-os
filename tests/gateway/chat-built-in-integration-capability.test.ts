import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { authMiddleware } from "../../packages/gateway/src/auth.js";
import { proxyIntegrationRequest } from "../../packages/gateway/src/integrations/platform-proxy.js";
import { authorizeChatIntegrationRequest } from "../../packages/gateway/src/integrations/chat-action-guard.js";
import { createMatrixMcpCapabilityRegistry } from "../../packages/gateway/src/chat/matrix-mcp-launch.js";

const owner = { type: "personal", ownerId: "owner_claude" };
const action = { service: "google_drive", action: "list_files", label: "work", params: { max_results: 3 } };
const tool = "mcp__matrix-integrations__call_service";

describe("Claude built-in integration authority", () => {
  it("issues Preview Drive authority only for a redeemed actor and exact run", () => {
    const registry = createMatrixMcpCapabilityRegistry({ configuredOwnerId: "preview_owner", previewRuntime: true });
    expect(registry.issue({ owner, runId: "run_1", scope: "chat_call" })).toBeNull();
    expect(registry.authorizePreviewDriveRun({ actorId: owner.ownerId, chatId: "chat_1", runId: "run_1", runGrant: "a".repeat(64) })).toBe(true);
    expect(registry.issue({ owner: { type: "personal", ownerId: "owner_other" }, runId: "run_1", scope: "chat_call" })).toBeNull();
    expect(registry.issue({ owner, runId: "run_2", scope: "chat_call" })).toBeNull();
    const capability = registry.issue({ owner, runId: "run_1", scope: "chat_call", fullAccess: false })!;
    expect(capability.surface).toBe("preview_drive_call");
    expect(registry.issue({ owner, runId: "run_1", scope: "chat_call" })).toBeNull();
    const context = registry.resolveRunContext(capability.token, "POST", "/api/integrations/call")!;
    expect(context.scope).toBe("preview_drive_call");
    expect(context.previewDrive).toMatchObject({ chatId: "chat_1", runId: "run_1", runGrant: "a".repeat(64) });
    for (const [method, path] of [["POST", "/api/integrations/connect"], ["POST", "/api/integrations/sync"],
      ["DELETE", "/api/integrations/00000000-0000-4000-8000-000000000001"],
      ["GET", "/api/mcp-servers"], ["POST", "/api/integrations/read-call"]]) {
      expect(registry.resolve(capability.token, method!, path!)).toBeNull();
    }
    expect(capability.grantIntegrationTool!(tool, { ...action, params: { maxResults: 4 } })).toBeNull();
    const exact = { ...action, params: { maxResults: 3 } };
    const local = capability.grantIntegrationTool!(tool, exact)!;
    expect(capability.bindPreviewActionGrant?.(local.receipt, "b".repeat(64))).toBe(true);
    expect(context.previewDrive!.consumeActionGrant(exact, local.receipt)).toBe("b".repeat(64));
    expect(context.previewDrive!.consumeActionGrant(exact, local.receipt)).toBeNull();
    capability.revoke(); registry.close();
  });
  it("routes only one approved Preview Drive read through the scoped Platform client", async () => {
    const registry = createMatrixMcpCapabilityRegistry({ configuredOwnerId: "preview_owner", previewRuntime: true });
    registry.authorizePreviewDriveRun({ actorId: owner.ownerId, chatId: "chat_1", runId: "run_1", runGrant: "a".repeat(64) });
    const capability = registry.issue({ owner, runId: "run_1", scope: "chat_call" })!;
    const discover = vi.fn(async () => []);
    const execute = vi.fn(async () => ({ service: "google_drive" as const, action: "list_files" as const,
      data: { files: [{ id: "file_1", name: "safe.txt" }] } }));
    const fetcher = vi.fn<typeof fetch>();
    const app = new Hono();
    app.use("*", authMiddleware("machine-secret", { resolveMatrixMcpRunContext: registry.resolveRunContext }));
    app.all("*", c => proxyIntegrationRequest(c, { targetBase: "https://platform.test/internal/integrations",
      machineToken: "machine-secret", fetcher, previewDriveClient: { discover, execute } as never }));
    const headers = { authorization: `Bearer ${capability.token}`, "content-type": "application/json" };
    expect((await app.request("/api/integrations", { headers })).status).toBe(200);
    expect(discover).toHaveBeenCalledWith({ runGrant: "a".repeat(64), chatId: "chat_1", runId: "run_1", kind: "inventory" });
    expect((await app.request("/api/integrations/call", { method: "POST", headers,
      body: JSON.stringify({ ...action, params: { maxResults: 3 } }) })).status).toBe(403);
    const exact = { ...action, params: { maxResults: 3 } };
    const local = capability.grantIntegrationTool!(tool, exact)!;
    capability.bindPreviewActionGrant!(local.receipt, "b".repeat(64));
    const approved = await app.request("/api/integrations/call", { method: "POST",
      headers: { ...headers, "x-matrix-integration-approval": local.receipt }, body: JSON.stringify(exact) });
    expect(approved.status).toBe(200);
    expect(await approved.json()).toEqual({ service: "google_drive", action: "list_files",
      data: { files: [{ id: "file_1", name: "safe.txt" }] } });
    expect(execute).toHaveBeenCalledWith({ runGrant: "a".repeat(64), chatId: "chat_1", runId: "run_1",
      actionGrant: "b".repeat(64), action: exact });
    expect((await app.request("/api/integrations/call", { method: "POST",
      headers: { ...headers, "x-matrix-integration-approval": local.receipt }, body: JSON.stringify(exact) })).status).toBe(403);
    expect(execute).toHaveBeenCalledOnce();
    expect(fetcher).not.toHaveBeenCalled();
    registry.close();
  });
  it("fails closed when local integration routes exist on a Preview runtime", async () => {
    const registry = createMatrixMcpCapabilityRegistry({ previewRuntime: true });
    registry.authorizePreviewDriveRun({ actorId: owner.ownerId, chatId: "chat_1", runId: "run_1", runGrant: "a".repeat(64) });
    const capability = registry.issue({ owner, runId: "run_1", scope: "chat_call" })!;
    const app = new Hono();
    app.use("*", authMiddleware("machine-secret", { resolveMatrixMcpRunContext: registry.resolveRunContext }));
    app.use("*", async (c, next) => {
      const denied = await authorizeChatIntegrationRequest(c, { localRoutes: true });
      if (denied) return denied;
      await next();
    });
    app.get("/api/integrations", c => c.json([{ service: "gmail", account_label: "other" }]));
    app.post("/api/integrations/call", c => c.json({ data: "local read" }));
    const headers = { authorization: `Bearer ${capability.token}` };
    expect((await app.request("/api/integrations", { headers })).status).toBe(503);
    expect((await app.request("/api/integrations/call", { method: "POST", headers,
      body: JSON.stringify({ ...action, params: { maxResults: 3 } }) })).status).toBe(503);
    registry.close();
  });
  it("keeps review metadata-only and full access within the fixed integration route set", () => {
    const registry = createMatrixMcpCapabilityRegistry({ configuredOwnerId: owner.ownerId });
    const review = registry.issue({ owner, runId: "review", scope: "chat_discovery", fullAccess: true })!;
    expect(registry.resolve(review.token, "GET", "/api/integrations")).toBe(owner.ownerId);
    expect(registry.resolve(review.token, "GET", "/api/integrations/agent-catalog")).toBe(owner.ownerId);
    expect(registry.resolve(review.token, "POST", "/api/integrations/call")).toBeNull();
    const full = registry.issue({ owner, runId: "full", scope: "chat_call", fullAccess: true })!;
    const context = registry.resolveRunContext(full.token, "POST", "/api/integrations/call")!;
    expect(context.consumeIntegrationRequest!("POST", "/api/integrations/call", action)).toBe(true);
    expect(context.consumeIntegrationRequest!("POST", "/api/integrations/call", { ...action, label: undefined })).toBe(false);
    for (const path of ["/api/integrations/read-call", "/api/integrations/apps", "/api/jev/evaluate", "/api/files"]) {
      expect(registry.resolve(full.token, "POST", path)).toBeNull();
    }
    registry.close();
    expect(context.consumeIntegrationRequest!("POST", "/api/integrations/call", action)).toBe(false);
  });

  it("expires action grants, bounds pending grants and isolates a new run", () => {
    let now = 0;
    const registry = createMatrixMcpCapabilityRegistry({ configuredOwnerId: owner.ownerId, now: () => now });
    const cap = registry.issue({ owner, runId: "first", scope: "chat_call" })!;
    const next = registry.issue({ owner, runId: "next", scope: "chat_call" })!;
    const current = registry.resolveRunContext(cap.token, "POST", "/api/integrations/call")!;
    const resumed = registry.resolveRunContext(next.token, "POST", "/api/integrations/call")!;
    const grant = cap.grantIntegrationTool!(tool, action)!;
    for (let i = 1; i < 16; i++) expect(cap.grantIntegrationTool!(tool, action)).not.toBeNull();
    expect(cap.grantIntegrationTool!(tool, action)).toBeNull();
    expect(resumed.consumeIntegrationRequest!("POST", "/api/integrations/call", action, grant.receipt)).toBe(false);
    now = 90_000;
    expect(current.consumeIntegrationRequest!("POST", "/api/integrations/call", action, grant.receipt)).toBe(false);
    const fresh = cap.grantIntegrationTool!(tool, action)!;
    expect(fresh).not.toBeNull();
    cap.revoke();
    expect(current.consumeIntegrationRequest!("POST", "/api/integrations/call", action, fresh.receipt)).toBe(false);
    expect(cap.grantIntegrationTool!(tool, action)).toBeNull();
    registry.close();
  });
  it("does not forward an unapproved or replayed request to Platform", async () => {
    const registry = createMatrixMcpCapabilityRegistry({ configuredOwnerId: owner.ownerId });
    const capability = registry.issue({ owner, runId: "run_proxy", scope: "chat_call" })!;
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ files: [] }));
    const app = new Hono();
    app.use("*", authMiddleware("host-secret", { resolveMatrixMcpRunContext: registry.resolveRunContext }));
    app.all("*", c => proxyIntegrationRequest(c, { targetBase: "https://platform.test/internal/integrations", machineToken: "platform-token", fetcher }));
    const request = (receipt?: string) => app.request("/api/integrations/call", { method: "POST",
      headers: { authorization: `Bearer ${capability.token}`, "content-type": "application/json",
        ...(receipt ? { "x-matrix-integration-approval": receipt } : {}) }, body: JSON.stringify(action) });
    expect((await request()).status).toBe(403);
    expect(fetcher).not.toHaveBeenCalled();
    const grant = capability.grantIntegrationTool!(tool, action)!;
    expect((await request()).status).toBe(403);
    expect((await request(grant.receipt)).status).toBe(200);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.parse(await (fetcher.mock.calls[0]![1]!.body as Blob).text())).toEqual(action);
    expect(new Headers(fetcher.mock.calls[0]![1]!.headers).has("x-matrix-integration-approval")).toBe(false);
    expect((await request(grant.receipt)).status).toBe(403);
    registry.close();
  });
  it("allows one exact approved action, rejects changed accounts/params and replay", () => {
    const registry = createMatrixMcpCapabilityRegistry({ configuredOwnerId: owner.ownerId });
    const capability = registry.issue({ owner, runId: "run_drive", scope: "chat_call" })!;
    expect(capability).not.toBeNull();
    const context = registry.resolveRunContext(capability.token, "POST", "/api/integrations/call")!;
    expect(context.consumeIntegrationRequest!("POST", "/api/integrations/call", action)).toBe(false);
    const grant = capability.grantIntegrationTool!(tool, action)!;
    expect(context.consumeIntegrationRequest!("POST", "/api/integrations/call", { ...action, label: "personal" }, grant.receipt)).toBe(false);
    expect(context.consumeIntegrationRequest!("POST", "/api/integrations/call", { ...action, params: { max_results: 100 } }, grant.receipt)).toBe(false);
    expect(context.consumeIntegrationRequest!("POST", "/api/integrations/call", action, grant.receipt)).toBe(true);
    expect(context.consumeIntegrationRequest!("POST", "/api/integrations/call", action, grant.receipt)).toBe(false);
    expect(capability.grantIntegrationTool!(tool, { ...action, label: undefined })).toBeNull();
    expect(registry.resolve(capability.token, "POST", "/api/chats/chat_1/runs/run_drive/approvals/a")).toBeNull();
    registry.close();
  });
});
