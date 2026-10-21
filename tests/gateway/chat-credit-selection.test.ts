import { describe, expect, it } from "vitest";
import { AiProviderSafeReasonSchema, aiProviderSafeReasonLabel, type CanonicalProviderCatalog, type CanonicalProviderInstanceDescriptor } from "@matrix-os/contracts";
import { createChatProviderRoutes } from "../../packages/gateway/src/chat/provider-routes.js";
import { createAiProviderRoutes } from "../../packages/gateway/src/ai-providers/routes.js";
import { canonicalProviderAvailabilityLabel, canonicalProviderUnavailableSelectionLabel } from "../../packages/ui/src/canonical-provider-choice.js";
import { managedPiChatInstances } from "../../packages/gateway/src/chat/managed-chat-catalog.js";
import { validateChatProviderSelection } from "../../packages/gateway/src/chat/provider-catalog.js";
import { makeAiProviderSnapshot } from "../fixtures/ai-provider-snapshot.js";

function validate(state: string, overrides: Partial<CanonicalProviderInstanceDescriptor> = {}) {
  const instance = { ...managedPiChatInstances(makeAiProviderSnapshot())[0]!, catalogRevision: "catalog_1",
    availability: "unavailable", connectionState: state, ...overrides } as CanonicalProviderInstanceDescriptor;
  return validateChatProviderSelection({ catalog: { instances: [instance] } as CanonicalProviderCatalog,
    selection: { instanceId: instance.id, model: "claude-sonnet-5" } });
}
describe("funded Chat admission errors", () => {
  it("accepts and labels the reviewed budget readiness reason", () => {
    expect(AiProviderSafeReasonSchema.parse("budget_exceeded")).toBe("budget_exceeded");
    expect(aiProviderSafeReasonLabel("budget_exceeded")).toBe("Monthly AI budget reached");
  });
  it.each([["credit_required", "insufficient_credit"], ["credit_reserved", "credit_reserved"], ["budget_exceeded", "budget_exceeded"]])(
    "retains trusted %s instead of generic unavailable", (state, code) => {
      expect(validate(state)).toMatchObject({ ok: false, error: { code, retryable: false } });
    });
  it.each(["credit_required", "credit_reserved", "budget_exceeded"])("rejects removed models before suggesting a %s funding remedy", state => {
    expect(validate(state, { models: [] })).toMatchObject({
      ok: false, error: { code: "model_unavailable", recoveryActions: ["select_provider"] },
    });
  });
  it.each(["credit_required", "credit_reserved", "budget_exceeded"])("ignores a funding hint on an unrelated connection or disabled runtime", (state) => {
    expect(validate(state, { id: "claude_code_default", driverKind: "claude_code" })).toMatchObject({ error: { code: "provider_unavailable" } });
    expect(validate(state, { unavailabilityReason: "disabled_in_settings" })).toMatchObject({ error: { code: "provider_unavailable" } });
  });
  it("keeps unknown/stale funding unavailable generic", () => {
    expect(validate("unavailable")).toMatchObject({ error: { code: "provider_unavailable" } });
  });
  it("labels budget exhaustion on the bound picker while keeping Settings disablement authoritative", () => {
    const instance = { ...managedPiChatInstances(makeAiProviderSnapshot())[0]!, catalogRevision: "catalog_1", availability: "unavailable", connectionState: "budget_exceeded" } as CanonicalProviderInstanceDescriptor;
    expect(canonicalProviderAvailabilityLabel(instance)).toBe("Monthly AI budget reached");
    expect(canonicalProviderUnavailableSelectionLabel(instance, "claude-sonnet-5")).toBe("Monthly budget reached");
    expect(canonicalProviderAvailabilityLabel({ ...instance, unavailabilityReason: "disabled_in_settings" })).toBe("Disabled in Settings");
    expect(canonicalProviderUnavailableSelectionLabel({ ...instance, unavailabilityReason: "disabled_in_settings" }, "claude-sonnet-5")).toBe("Unavailable");
  });
});

describe("funded reason rollout negotiation", () => {
  it.each([false, true])("keeps budget unavailable generic unless Chat funding is negotiated: %s", async (rich) => {
    const instance = { ...managedPiChatInstances(makeAiProviderSnapshot())[0]!, catalogRevision: "catalog_1", availability: "unavailable", connectionState: "budget_exceeded" } as CanonicalProviderInstanceDescriptor;
    const catalog = { instances: [instance] } as CanonicalProviderCatalog;
    const routes = createChatProviderRoutes({ catalog: { getCatalog: async () => catalog, refresh: async () => catalog }, getPrincipal: () => ({ userId: "owner", source: "jwt" }) });
    const response = await routes.request(`/api/chat-providers?includeConnectionState=true&includeFundingState=true${rich ? "&includeChatFunding=true" : ""}`);
    expect(response.status).toBe(200);
    expect((await response.json()).instances[0].connectionState).toBe(rich ? "budget_exceeded" : "unavailable");
    expect(instance.connectionState).toBe("budget_exceeded");
    const snapshot = makeAiProviderSnapshot();
    Object.assign(snapshot.accessSources[0]!, { state: "unavailable", safeReason: "budget_exceeded" });
    const providerRoutes = createAiProviderRoutes({ service: { getSnapshot: async () => snapshot }, getPrincipal: () => undefined });
    const sourceResponse = await providerRoutes.request(`/providers?includeFundingState=true${rich ? "&includeChatFunding=true" : ""}`);
    expect(sourceResponse.status).toBe(200);
    expect((await sourceResponse.json()).accessSources[0].safeReason).toBe(rich ? "budget_exceeded" : "policy");
    expect(snapshot.accessSources[0]!.safeReason).toBe("budget_exceeded");
  });
});
