import { expect, it } from "vitest";
import { matrixAnthropicSelectionBinding, sameMatrixAnthropicSelectionBinding, isMatrixAnthropicChatRoute, isMatrixAnthropicBotRoute, isPiBotCoordinatorRoute, canonicalProviderModelRouteLabel, botModelRoutingLabel } from "@matrix-os/contracts";
import { createCanonicalProviderCatalogFixture } from "./fixtures/canonical-chat.js";
import { MatrixAnthropicConnectionSchema, MatrixAnthropicConnectSchema, MatrixAnthropicDisconnectSchema, MatrixAnthropicRefreshSchema, MatrixAnthropicSourceStateSchema } from "../../packages/contracts/src/matrix-anthropic-connection.js";

const generation = "5d6e6f01-bf1e-4000-8000-000000000001";
const ready = {
  connectionId: "matrix_anthropic_api", providerId: "anthropic", executionKind: "direct_pi", billingKind: "api_key",
  revision: 1, enabled: true, credentialGeneration: generation, sourceCredentialGeneration: generation, state: "ready",
  models: [{ id: "claude-observed", displayName: "Observed Claude" }], actions: ["connect", "refresh", "disconnect"],
  checkedAt: "2026-10-07T00:00:00Z", staleAfter: "2026-10-07T00:01:00Z", supports: { rootChat: true, recipeBots: true },
};
it("accepts bounded generation-qualified Matrix API status and refuses native/secret/unsupported authority", () => {
  expect(MatrixAnthropicConnectionSchema.parse(ready)).toEqual(ready);
  for (const changes of [
    { executionKind: "native" }, { billingKind: "subscription" }, { providerId: "openai" },
    { apiKey: "sk-secret" }, { payloadHash: "a".repeat(64) }, { remainingCredit: 100 },
    { sourceCredentialGeneration: "5d6e6f01-bf1e-4000-8000-000000000002" }, { credentialGeneration: null },
    { enabled: false }, { models: [] }, { checkedAt: null }, { staleAfter: ready.checkedAt },
    { state: "read_only" }, { state: "unsupported" }, { actions: ["connect", "connect"] },
    { models: Array.from({ length: 257 }, (_, index) => ({ id: `claude-${index}`, displayName: "Claude" })) },
  ]) expect(MatrixAnthropicConnectionSchema.safeParse({ ...ready, ...changes }).success).toBe(false);
});
it("requires revision and canonical generation CAS for strict bounded connection mutations", () => {
  const common = { expectedRevision: 1, expectedCredentialGeneration: generation, idempotencyKey: "request-1" };
  expect(MatrixAnthropicConnectSchema.parse({ ...common, apiKey: "sk-owner-api-key" })).toEqual({ ...common, apiKey: "sk-owner-api-key" });
  for (const schema of [MatrixAnthropicDisconnectSchema, MatrixAnthropicRefreshSchema]) {
    expect(schema.parse(common)).toEqual(common);
    expect(schema.safeParse({ ...common, apiKey: "sk-owner-api-key" }).success).toBe(false);
  }
  for (const changes of [{ expectedCredentialGeneration: undefined }, { expectedCredentialGeneration: "key-digest" },
    { expectedRevision: -1 }, { expectedRevision: Number.MAX_SAFE_INTEGER + 1 }, { idempotencyKey: "x".repeat(129) },
    { apiKey: "short" }, { apiKey: "x".repeat(4097) }, { apiKey: "key\ninvalid" }, { apiKey: "key\0invalid" }, { harnessInstanceId: "native_claude" }]) {
    expect(MatrixAnthropicConnectSchema.safeParse({ ...common, apiKey: "sk-owner-api-key", ...changes }).success).toBe(false);
  }
});
it("keeps disabled and inaccessible intent safe without usable models or invented source authority", () => {
  const unavailable = { ...ready, state: "refresh_required", models: [] };
  expect(MatrixAnthropicConnectionSchema.parse(unavailable).enabled).toBe(true);
  for (const state of ["unsupported", "read_only"]) expect(MatrixAnthropicConnectionSchema.safeParse({ ...unavailable,
    state, actions: [], supports: { rootChat: false, recipeBots: false } }).success).toBe(true);
  expect(MatrixAnthropicSourceStateSchema.parse({ version: 1, revision: 0, enabled: false, credentialGeneration: null })).toMatchObject({ enabled: false });
  expect(MatrixAnthropicSourceStateSchema.safeParse({ version: 1, revision: 0, enabled: true, credentialGeneration: null }).success).toBe(false);
  expect(MatrixAnthropicSourceStateSchema.safeParse({ version: 1, revision: 1, enabled: true, credentialGeneration: generation, receipts: [] }).success).toBe(false);
});

const options = [{ id: "connectionRevision", value: "3" }, { id: "credentialGeneration", value: "e16625fe-cad7-4983-a9db-e808bbf104cc" }];
it("binds API-paid choices to the exact source generation and revision", () => {
  expect(matrixAnthropicSelectionBinding(options)).toEqual({ connectionRevision: 3, credentialGeneration: options[1]!.value });
  expect(sameMatrixAnthropicSelectionBinding(options, [...options].reverse())).toBe(true);
  expect(matrixAnthropicSelectionBinding([...options, options[0]!])).toBeNull();
  for (const value of ["0", "-1", "1e3", "9007199254740992", true]) expect(matrixAnthropicSelectionBinding([{ ...options[0]!, value }, options[1]!])).toBeNull();
  expect(matrixAnthropicSelectionBinding([options[0]!, { ...options[1]!, value: "invalid" }])).toBeNull();
  expect(sameMatrixAnthropicSelectionBinding(options, [{ ...options[0]!, value: "4" }, options[1]!])).toBe(false);
});
it("keeps ordinary and recipe API-paid identities distinct and labels payment truthfully", () => {
  expect(isMatrixAnthropicChatRoute({ instanceId: "matrix_pi_anthropic_api", driverKind: "matrix_pi" })).toBe(true);
  expect(isMatrixAnthropicChatRoute({ instanceId: "matrix_pi_anthropic_api", driverKind: "pi" })).toBe(false);
  expect(isMatrixAnthropicBotRoute({ instanceId: "matrix_anthropic_api", driverKind: "matrix_bot" })).toBe(true);
  expect(isPiBotCoordinatorRoute({ instanceId: "matrix_anthropic_api", driverKind: "matrix_bot" })).toBe(true);
  const base = createCanonicalProviderCatalogFixture();
  const instance = { ...base.instances[0]!, id: "matrix_anthropic_api", driverKind: "matrix_bot" as const, models: [{ ...base.instances[0]!.models[0]!, id: "claude-test", displayName: "Claude Test" }], defaultSelection: { instanceId: "matrix_anthropic_api", model: "claude-test", options } };
  base.instances = [instance];
  expect(canonicalProviderModelRouteLabel(instance, "Claude Test")).toBe("Claude Test · Matrix AI · Anthropic API");
  expect(botModelRoutingLabel(instance.defaultSelection, base)).toBe("Anthropic API · Claude Test");
  expect(botModelRoutingLabel({ ...instance.defaultSelection, options: [{ ...options[0]!, value: "4" }, options[1]!] }, base)).toBe("Anthropic API · Claude Test · unavailable");
});
