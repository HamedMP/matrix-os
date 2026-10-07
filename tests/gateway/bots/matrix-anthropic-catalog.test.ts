import { expect, it, vi } from "vitest";
import { providerSettingsCanonicalFixture } from "../provider-settings-test-support.js";
import { withMatrixAnthropicProviderInstances } from "../../../packages/gateway/src/bots/matrix-anthropic-provider-instance.js";
import { CanonicalProviderCatalogSchema } from "@matrix-os/contracts";
import { createCanonicalProviderCatalogFixture } from "../../contracts/fixtures/canonical-chat.js";
const gen = "e16625fe-cad7-4983-a9db-e808bbf104cc";
const status = { connectionId: "matrix_anthropic_api" as const, providerId: "anthropic" as const, executionKind: "direct_pi" as const, billingKind: "api_key" as const,
 revision: 3, enabled: true, credentialGeneration: gen, sourceCredentialGeneration: gen, state: "ready" as const,
 models: [{ id: "claude-model", displayName: "Claude Model" }], actions: ["connect", "refresh", "disconnect"] as const, checkedAt: "2026-10-07T00:00:00Z", staleAfter: "2026-10-08T00:00:00Z", supports: { rootChat: true, recipeBots: true } };
function fixture(ready = true, runtime = true) {
 const base = { getCatalog: vi.fn(async () => ({ revision: "base", drivers: [], instances: [] })) };
 const authority = { getSnapshot: vi.fn(async () => ({ ...providerSettingsCanonicalFixture(), matrixAnthropicConnection: { ...status, actions: [...status.actions], ...(!ready ? { state: "auth_required" as const, models: [] } : {}) } })) };
 return { service: withMatrixAnthropicProviderInstances(base, authority, () => runtime, "owner"), base, authority };
}
it("projects qualified API-paid Chat and recipe descriptors with exact source bindings", async () => {
 const f = fixture(); const catalog = await f.service.getCatalog({ userId: "owner", source: "jwt" });
 expect(f.authority.getSnapshot).toHaveBeenCalledWith({ admissionScope: "managed_matrix", suppressFundedProbes: true });
 const chat = catalog.instances.find(i => i.id === "matrix_pi_anthropic_api")!;
 const bot = catalog.instances.find(i => i.id === "matrix_anthropic_api")!;
 expect(chat.driverKind).toBe("matrix_pi"); expect(bot.driverKind).toBe("matrix_bot"); expect(bot.supports.rootChat).toBe(false);
 expect(chat.defaultSelection?.options).toEqual([{ id: "connectionRevision", value: "3" }, { id: "credentialGeneration", value: gen }]);
 expect(CanonicalProviderCatalogSchema.parse(catalog).instances).toHaveLength(2);
 expect(chat.supports.rootChat).toBe(true);
 expect(chat.connectionLabel).toBe("Anthropic API");
 expect(bot.connectionLabel).toBe("Anthropic API");
 expect(chat.models.map(model => model.id)).toEqual(["claude-model"]);
 expect(bot.models.map(model => model.id)).toEqual(["claude-model"]);
 expect(bot.defaultSelection?.options).toEqual(chat.defaultSelection?.options);

});
it("retains source-specific setup actions but no executable model after revocation or absent runtime", async () => {
 const absent = await fixture(false).service.getCatalog({ userId: "owner", source: "jwt" });
 expect(absent.instances.every(i => i.models.length === 0 && !i.defaultSelection)).toBe(true);
 expect(absent.instances.find(i => i.id === "matrix_pi_anthropic_api")!.setupActions[0]!.kind).toBe("open_settings");
 const noRuntime = await fixture(true, false).service.getCatalog({ userId: "owner", source: "jwt" });
 expect(noRuntime.instances.every(instance => instance.availability === "unavailable" && instance.models.length === 0 && !instance.defaultSelection)).toBe(true);
});
it("projects an API-paid recipe coordinator from its own catalog source", async () => {
 const { withBotProviderInstance } = await import("../../../packages/gateway/src/bots/provider-instance.js");
 const service = fixture().service, original = await service.getCatalog({ userId: "owner", source: "jwt" });
 const selection = original.instances.find(i => i.id === "matrix_anthropic_api")!.defaultSelection!;
 const catalog = await withBotProviderInstance(service).getCatalog({ userId: "owner", source: "jwt" }, { ...selection, instanceId: "matrix_bot_default" });
 expect(catalog.instances[0]!.availability).toBe("available");
 expect(catalog.instances[0]!.defaultSelection?.options).toEqual(selection.options);
 expect(catalog.instances[0]!.connectionLabel).toBe("Anthropic API");
});
it("keeps other shared-Computer catalogs usable without exposing an owner's API source", async () => {
 const base = { getCatalog: async () => ({ revision: "base", drivers: [], instances: [] }) };
 const service = withMatrixAnthropicProviderInstances(base, { getSnapshot: async () => { throw new Error("Nonowner must not read authority"); } }, () => true, "owner");
 expect(await service.getCatalog({ userId: "other-owner", source: "jwt" })).toEqual(await base.getCatalog());
});
it.each([65, 256])("bounds both Anthropic catalogs when the qualified source returns %i models", async count => {
 const models = Array.from({ length: count }, (_, index) => ({ id: `claude-model-${index}`, displayName: `Claude ${index}` }));
 const inherited = createCanonicalProviderCatalogFixture();
 const base = { getCatalog: async () => inherited };
 const providers = { getSnapshot: async () => ({ ...providerSettingsCanonicalFixture(), matrixAnthropicConnection: { ...status, actions: [...status.actions], models } }) };
 const result = await withMatrixAnthropicProviderInstances(base, providers, () => true, "owner").getCatalog({ userId: "owner", source: "jwt" });
 const parsed = CanonicalProviderCatalogSchema.parse(result);
 expect(parsed.instances.find(instance => instance.id === inherited.instances[0]!.id)?.models).toEqual(inherited.instances[0]!.models);
 for (const id of ["matrix_anthropic_api", "matrix_pi_anthropic_api"]) {
   const instance = parsed.instances.find(candidate => candidate.id === id)!;
   expect(instance.models).toHaveLength(64);
   expect(instance.models.map(model => model.id)).toEqual(models.slice(0, 64).map(model => model.id));
   expect(instance.defaultSelection?.model).toBe(models[0]!.id);
 }
});
