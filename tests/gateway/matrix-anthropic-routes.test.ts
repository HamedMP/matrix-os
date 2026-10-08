import { Hono, type Context } from "hono";
import { providerSettingsCanonicalFixture } from "./provider-settings-test-support.js";
import { MatrixAnthropicConnectionSchema } from "@matrix-os/contracts";
import { createMatrixAnthropicRuntime } from "../../packages/gateway/src/server/matrix-anthropic-runtime.js";
import { expect, it, vi } from "vitest";
import { createMatrixAnthropicConnectionRoutes } from "../../packages/gateway/src/ai-providers/matrix-anthropic-connection-routes.js";
import { MatrixAnthropicConnectionError, type MatrixAnthropicConnectionService } from "../../packages/gateway/src/ai-providers/matrix-anthropic-connection.js";
import { createAiProviderRoutes } from "../../packages/gateway/src/ai-providers/routes.js";
import { createProviderSettingsRoutes } from "../../packages/gateway/src/ai-providers/provider-settings-routes.js";
import { projectProviderSettings } from "../../packages/gateway/src/ai-providers/provider-settings-projector.js";
import { initialProviderSettingsConfiguration } from "../../packages/gateway/src/ai-providers/provider-settings-persistence.js";
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

it.each([true, false])("isolates mounted connection middleware from sibling reads and neighboring prefixes with connection dependencies %s", async available => {
  const app = new Hono(), f = fixture();
  const getPrincipal = (context: Context) => { const userId = context.req.header("x-test-principal"); return userId ? { userId } : null; };
  const canonical = { ...providerSettingsCanonicalFixture(), matrixAnthropicConnection: MatrixAnthropicConnectionSchema.parse(status) };
  const canonicalRead = vi.fn(async () => canonical);
  const connectionRead = vi.fn(async () => canonical);
  const settings = await projectProviderSettings({ canonical, config: initialProviderSettingsConfiguration(canonical), now: new Date(canonical.refreshedAt), supportedActions: [] });
  app.route("/api/ai", createMatrixAnthropicConnectionRoutes({ ownerId: "owner", service: available ? { observe: f.observe, connect: f.connect, refresh: f.refresh, disconnect: f.disconnect } as unknown as MatrixAnthropicConnectionService : null,
    providerSnapshotReader: available ? { getSnapshot: connectionRead } : undefined, getPrincipal }));
  app.route("/api/ai", createAiProviderRoutes({ service: { getSnapshot: canonicalRead }, getPrincipal, canReadMatrixConnections: context => getPrincipal(context)?.userId === "owner" }));
  app.route("/api/ai", createProviderSettingsRoutes({ store: { getSnapshot: async () => settings, mutate: async () => { throw new Error("Read-only synthetic fixture"); } }, getPrincipal, canReadNativeAccountMetadata: context => getPrincipal(context)?.userId === "owner" }));
  app.post("/api/ai/matrix-connections/anthropic-other", async context => context.text(await context.req.text()));
  for (const principal of available ? ["shared", "owner"] : ["owner", "shared"]) {
    for (const sibling of ["/providers", "/provider-settings"]) {
      const response = await app.request("/api/ai" + sibling + "?includeMatrixAnthropicConnection=true", { headers: { "x-test-principal": principal } });
      expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect("matrixAnthropicConnection" in await response.json()).toBe(principal === "owner");
    }
  }
  const neighboring = await app.request("/api/ai" + path + "-other", { method: "POST", body: "x".repeat(9000) });
  expect(neighboring.status).toBe(200); expect((await neighboring.text()).length).toBe(9000);
  expect(connectionRead).not.toHaveBeenCalled(); expect(f.observe).not.toHaveBeenCalled(); expect(f.connect).not.toHaveBeenCalled();
  for (const suffix of ["", "/connect", "/refresh", "/disconnect", "/unknown"]) {
    for (const [principal, code] of [[undefined, 401], ["shared", 403], ["owner", available ? suffix === "/unknown" ? 404 : suffix ? 400 : 200 : 503]] as const) {
      const response = await app.request("/api/ai" + path + suffix, { method: suffix ? "POST" : "GET", headers: principal ? { "x-test-principal": principal } : {}, ...(suffix ? { body: "malformed" } : {}) });
      expect(response.status).toBe(code); expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
  }
  if (available) {
    expect(connectionRead).toHaveBeenCalledTimes(1);
    expect(connectionRead).toHaveBeenCalledWith({ admissionScope: "managed_matrix", suppressFundedProbes: true });
    const oversized = post({ padding: "x".repeat(9000) });
    for (const suffix of ["/connect", "/refresh", "/disconnect", "/unknown"]) expect((await app.request("/api/ai" + path + suffix,
      { ...oversized, headers: { ...oversized.headers, "Content-Length": String(Buffer.byteLength(oversized.body)) } })).status).toBe(413);
  }
  expect(f.observe).not.toHaveBeenCalled(); expect(f.connect).not.toHaveBeenCalled(); expect(f.refresh).not.toHaveBeenCalled(); expect(f.disconnect).not.toHaveBeenCalled();
});
