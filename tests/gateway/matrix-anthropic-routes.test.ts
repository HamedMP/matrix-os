import { Hono } from "hono";
import { providerSettingsCanonicalFixture } from "./provider-settings-test-support.js";
import { MatrixAnthropicConnectionSchema } from "@matrix-os/contracts";
import { createMatrixAnthropicRuntime } from "../../packages/gateway/src/server/matrix-anthropic-runtime.js";
import { expect, it, vi } from "vitest";
import { createMatrixAnthropicConnectionRoutes } from "../../packages/gateway/src/ai-providers/matrix-anthropic-connection-routes.js";
import { MatrixAnthropicConnectionError, type MatrixAnthropicConnectionService } from "../../packages/gateway/src/ai-providers/matrix-anthropic-connection.js";
const status = { connectionId: "matrix_anthropic_api", providerId: "anthropic", executionKind: "direct_pi", billingKind: "api_key", revision: 0, enabled: false,
  credentialGeneration: null, sourceCredentialGeneration: null, state: "disconnected", models: [], actions: ["connect"], checkedAt: null, staleAfter: null, supports: { rootChat: true, recipeBots: false } };
function fixture() {
  const observe = vi.fn(async () => status), connect = vi.fn(async () => status), refresh = vi.fn(async () => status), disconnect = vi.fn(async () => status);
  const service = { observe, connect, refresh, disconnect } as unknown as MatrixAnthropicConnectionService;
  const app = createMatrixAnthropicConnectionRoutes({ service, ownerId: "owner", providerSnapshotReader: { getSnapshot: async () => ({ ...providerSettingsCanonicalFixture(), matrixAnthropicConnection: MatrixAnthropicConnectionSchema.parse(await service.observe("owner")) }) }, getPrincipal: context => { const userId = context.req.header("x-test-principal"); return userId ? { userId } : null; } });
  return { app, observe, connect, refresh, disconnect };
}
const path = "/matrix-connections/anthropic", body = { apiKey: "sk-ant-only-synthetic", expectedRevision: 0, expectedCredentialGeneration: null, idempotencyKey: "one" };
const post = (value: unknown) => ({ method: "POST", headers: { "x-test-principal": "owner", "Content-Type": "application/json" }, body: JSON.stringify(value) });
it("enforces authentication and exact owner before parsing or probing with private no-store replies", async () => {
  const { app, observe, connect } = fixture();
  for (const [principal, code] of [[undefined, 401], ["other", 403]] as const) {
    const response = await app.request(path + "/connect", { method: "POST", headers: principal ? { "x-test-principal": principal } : {}, body: "malformed" });
    expect(response.status).toBe(code); expect(response.headers.get("cache-control")).toBe("private, no-store");
  }
  expect(connect).not.toHaveBeenCalled(); const response = await app.request(path, { headers: { "x-test-principal": "owner" } });
  expect(response.status).toBe(200); expect(observe).toHaveBeenCalledWith("owner");
});
it("validates every action and body bound, then passes exact owner and payload", async () => {
  const { app, connect, refresh, disconnect } = fixture();
  expect((await app.request(path + "/connect", post(body))).status).toBe(200); expect(connect).toHaveBeenCalledWith("owner", body);
  for (const value of [{ ...body, providerUrl: "https://evil.invalid" }, { ...body, expectedCredentialGeneration: undefined }, { ...body, apiKey: "x" }])
    expect((await app.request(path + "/connect", post(value))).status).toBe(400);
  expect((await app.request(path + "/connect", post({ ...body, apiKey: "x".repeat(9000) }))).status).toBe(413);
  const mutation = { expectedRevision: body.expectedRevision, expectedCredentialGeneration: body.expectedCredentialGeneration, idempotencyKey: body.idempotencyKey };
  expect((await app.request(path + "/refresh", post(mutation))).status).toBe(200); expect(refresh).toHaveBeenCalledWith("owner", mutation);
  expect((await app.request(path + "/disconnect", post(mutation))).status).toBe(200); expect(disconnect).toHaveBeenCalledWith("owner", mutation);
  expect((await app.request(path + "/disconnect", post(body))).status).toBe(400);
});
it("maps safe errors and never leaks upstream secrets or server error messages", async () => {
  const { app, connect } = fixture(); connect.mockRejectedValueOnce(new MatrixAnthropicConnectionError("conflict"));
  expect((await app.request(path + "/connect", post(body))).status).toBe(409);
  connect.mockRejectedValueOnce(new Error("synthetic secret key /private/path upstream detail"));
  const response = await app.request(path + "/connect", post(body)); expect(response.status).toBe(503);
  expect(await response.text()).not.toContain("synthetic secret"); expect(response.headers.get("cache-control")).toBe("private, no-store");
});

it("registers safe missing-dependency routes with owner denial before unavailable fallback", async () => {
  const app = new Hono();
  const runtime = createMatrixAnthropicRuntime({ app, homePath: null, ownerId: "owner", profileGuard: null, supports: { rootChat: false, recipeBots: false },
    getPrincipal: context => { const userId = context.req.header("x-test-principal"); return userId ? { userId } : null; } });
  expect(runtime.service).toBeNull();
  for (const [principal, status] of [[undefined, 401], ["other", 403], ["owner", 503]] as const) {
    const response = await app.request("/api/ai" + path, { headers: principal ? { "x-test-principal": principal } : {} });
    expect(response.status).toBe(status); expect(response.headers.get("cache-control")).toBe("private, no-store");
  }
  await runtime.close();
});
