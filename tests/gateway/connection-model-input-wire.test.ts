import { expect, it } from "vitest";
import { MatrixAnthropicConnectionSchema, BotProviderConnectionsSchema } from "@matrix-os/contracts";
import { createAiProviderRoutes } from "../../packages/gateway/src/ai-providers/routes.js";
import { createMatrixAnthropicConnectionRoutes } from "../../packages/gateway/src/ai-providers/matrix-anthropic-connection-routes.js";
import type { MatrixAnthropicConnectionService } from "../../packages/gateway/src/ai-providers/matrix-anthropic-connection.js";
import { createBotProviderConnectionRoutes } from "../../packages/gateway/src/bots/provider-connection-routes.js";
import type { BotProviderConnectionsService } from "../../packages/gateway/src/bots/provider-connections.js";
import { makeAiProviderSnapshot } from "../fixtures/ai-provider-snapshot.js";
import { createProviderSettingsRoutes } from "../../packages/gateway/src/ai-providers/provider-settings-routes.js";
import { projectProviderSettings } from "../../packages/gateway/src/ai-providers/provider-settings-projector.js";
import { initialProviderSettingsConfiguration } from "../../packages/gateway/src/ai-providers/provider-settings-persistence.js";
import { providerSettingsCanonicalFixture } from "./provider-settings-test-support.js";

const model = { id: "vision-model", displayName: "Observed vision model", input: ["text", "image"] };
const publicModel = { id: model.id, displayName: model.displayName };
const generation = "00000000-0000-4000-8000-000000000001";
const connection = MatrixAnthropicConnectionSchema.parse({
  connectionId: "matrix_anthropic_api", providerId: "anthropic", executionKind: "direct_pi", billingKind: "api_key",
  revision: 1, enabled: true, credentialGeneration: generation, sourceCredentialGeneration: generation,
  state: "ready", models: [model], actions: ["refresh", "disconnect"],
  checkedAt: "2026-10-12T00:00:00Z", staleAfter: "2026-10-12T01:00:00Z", supports: { rootChat: true, recipeBots: true },
});
const snapshot = { ...makeAiProviderSnapshot(), matrixAnthropicConnection: connection };

it("keeps observed model input internal when reading the owner provider snapshot", async () => {
  const app = createAiProviderRoutes({ service: { getSnapshot: async () => snapshot }, getPrincipal: () => ({ userId: "owner" }), canReadMatrixConnections: () => true });
  const response = await app.request("/providers?includeMatrixAnthropicConnection=true&includeNativeProfiles=true");
  expect(response.status).toBe(200);
  expect((await response.json()).matrixAnthropicConnection.models).toEqual([publicModel]);
  expect(snapshot.matrixAnthropicConnection.models[0]!.input).toEqual(["text", "image"]);
});

it("keeps Settings connection models readable by existing strict clients", async () => {
  const canonical = { ...providerSettingsCanonicalFixture(), matrixAnthropicConnection: connection };
  const settings = await projectProviderSettings({ canonical, config: initialProviderSettingsConfiguration(canonical), now: new Date(canonical.refreshedAt), supportedActions: [] });
  const app = createProviderSettingsRoutes({ store: { getSnapshot: async () => settings, mutate: async () => { throw new Error("Read-only fixture"); } },
    getPrincipal: () => ({ userId: "owner" }), canReadNativeAccountMetadata: () => true });
  const response = await app.request("/provider-settings?includeMatrixAnthropicConnection=true");
  expect(response.status).toBe(200);
  expect((await response.json()).matrixAnthropicConnection.models).toEqual([publicModel]);
  expect(settings.matrixAnthropicConnection!.models[0]!.input).toEqual(["text", "image"]);
});

it("preserves legacy model fields in connection reads and every action response", async () => {
  const service = { connect: async () => connection, refresh: async () => connection, disconnect: async () => connection } as unknown as MatrixAnthropicConnectionService;
  const app = createMatrixAnthropicConnectionRoutes({ service, ownerId: "owner", getPrincipal: () => ({ userId: "owner" }), providerSnapshotReader: { getSnapshot: async () => snapshot } });
  const mutation = { expectedRevision: 1, expectedCredentialGeneration: generation, idempotencyKey: "fixture" };
  for (const suffix of ["", "/connect", "/refresh", "/disconnect"]) {
    const response = await app.request(`/matrix-connections/anthropic${suffix}`, suffix ? {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...mutation, ...(suffix === "/connect" ? { apiKey: "synthetic-only-key" } : {}) }),
    } : undefined);
    expect(response.status).toBe(200);
    expect((await response.json()).models).toEqual([publicModel]);
  }
  expect(connection.models[0]!.input).toEqual(["text", "image"]);
});

it("projects both Bot connection inventory and authorization results without mutating source capabilities", async () => {
  const connections = BotProviderConnectionsSchema.parse({ connections: [{ id: "matrix_chatgpt_plan", providerId: "openai", executionKind: "direct_pi",
    availability: "available", accountId: "synthetic-account", models: [model], authorization: { revision: 1, enabled: true, background: false }, coordinatorFunding: "subscription" }] });
  const service = { connections: async () => connections, authorize: async () => connections } as unknown as BotProviderConnectionsService;
  const app = createBotProviderConnectionRoutes({ service, getPrincipal: () => ({ userId: "owner", source: "jwt" }) });
  for (const [url, request] of [
    ["/api/bot-connections?includeChatgptPlan=true", undefined],
    ["/api/bot-connections/claude_code_tasks/authorization", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ baseRevision: 0, enabled: true, background: false }) }],
  ] as const) {
    const response = await app.request(url, request);
    expect(response.status).toBe(200);
    expect((await response.json()).connections[0].models).toEqual([publicModel]);
  }
  expect(connections.connections[0]!.models[0]!.input).toEqual(["text", "image"]);
});
