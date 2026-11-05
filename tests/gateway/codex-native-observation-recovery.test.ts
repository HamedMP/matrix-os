import { z } from "zod/v4";
import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AiProviderSnapshotV3Schema, CanonicalProviderCatalogSchema } from "@matrix-os/contracts";
import { ProviderSettingsStore } from "../../packages/gateway/src/ai-providers/provider-settings-store.js";
import { initialProviderSettingsConfiguration, writeProviderJsonAtomic } from "../../packages/gateway/src/ai-providers/provider-settings-persistence.js";
import { bindNativeAccountMetadata, nativeAccountPrincipalFingerprint } from "../../packages/gateway/src/ai-providers/native-account-metadata-binding.js";
import { normalizeCodexNativeAccountMetadata, type CodexNativeAccountMetadataReader, type CodexNativeAccountObservation } from "../../packages/gateway/src/ai-providers/codex-native-account-metadata.js";
import { createChatProviderCatalogService, validateChatProviderSelection } from "../../packages/gateway/src/chat/provider-catalog.js";
import { createChatProviderRoutes } from "../../packages/gateway/src/chat/provider-routes.js";
import { canonicalProviderAvailabilityLabel, deriveCanonicalProviderChoices } from "../../packages/ui/src/canonical-provider-choice.js";
import { deriveChatPickerModelRows } from "../../packages/ui/src/chat-picker-entries.js";
import { providerSettingsCanonicalFixture, PROVIDER_SETTINGS_NOW as now } from "./provider-settings-test-support.js";
const homes: string[] = [];
afterEach(async () => { await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true }))); });
const selection = { instanceId: "codex_default", model: "codex-model" };
const principal = { userId: "fixture-owner", source: "jwt" as const };
async function fixture() {
  const canonical = providerSettingsCanonicalFixture();
  const unknown = { state: "unknown" as const, checkedAt: null, staleAfter: null, action: "retry" as const, safeReason: "unknown" as const };
  canonical.drivers.push({ ...canonical.drivers[1]!, id: "codex", displayName: "Codex" });
  canonical.accessSources.push({ ...canonical.accessSources[1]!, id: "owner_openai_profile", vendor: "openai", accountLabel: "Codex", eligibleModelIds: ["codex-model"], ...unknown,
    localObservation: { state: "present_unverified", checkedAt: now.toISOString(), staleAfter: new Date(+now + 5000).toISOString() } });
  canonical.accounts.push({ ...canonical.accounts[0]!, id: "owner_codex", vendor: "openai", authMethod: "provider_profile", accountLabel: "Codex", ...unknown });
  canonical.instances.push({ ...canonical.instances[1]!, id: "codex_owner", driverId: "codex", accountId: "owner_codex", accessSourceId: "owner_openai_profile", vendor: "openai", readiness: unknown, modelIds: ["codex-model"], defaultModelId: null });
  canonical.models.push({ ...canonical.models[0]!, id: "codex-model", vendor: "openai", eligibleAccessSourceIds: ["owner_openai_profile"], dataPolicies: [{ accessSourceId: "owner_openai_profile", route: "owner_direct", disclosureKey: "owner-openai" }] });
  AiProviderSnapshotV3Schema.parse(canonical);
  const config = initialProviderSettingsConfiguration(canonical);
  const metadata = bindNativeAccountMetadata(normalizeCodexNativeAccountMetadata({ account: { type: "chatgpt", email: "fixture@example.test", planType: "pro" } }, undefined, now)!, async () => true, "unchanged-private-fixture-principal");
  const stored = config.harnesses.find(row => row.harness === "codex")!;
  stored.nativeAccountGeneration = nativeAccountPrincipalFingerprint(metadata)!;
  stored.nativeAccountConsentRevision = config.revision;
  stored.selectedAccountId = "owner_codex";
  stored.enabled = true;
  const homePath = await mkdtemp(join(tmpdir(), "codex-discovery-recovery-")); homes.push(homePath);
  const save = () => writeProviderJsonAtomic(join(homePath, "system/ai-providers/settings.json"), config);
  await save();
  let observation: CodexNativeAccountObservation = { state: "observed", metadata };
  const observeIdentity = vi.fn(async () => observation);
  const native = Object.assign(vi.fn(async () => metadata), { observeIdentity }) satisfies CodexNativeAccountMetadataReader;
  const store = new ProviderSettingsStore({ homePath, now: () => now, providerSnapshotReader: { getSnapshot: async () => structuredClone(canonical) }, codexNativeAccountMetadataReader: native });
  const service = createChatProviderCatalogService({
    codingProviders: { listProviders: async () => [{ id: "codex", kind: "codex", displayName: "Codex", availability: "available", installStatus: "installed", authStatus: "authenticated", supportedModes: ["default"], defaultMode: "default", defaultModel: "codex-model", setupActions: [] }], invalidate() {} },
    agentRuntimeSource: async () => { throw Error("Unrelated system source"); },
    codingModelCatalogSource: async () => ({ models: [{ id: "codex-model", displayName: "Codex model", capabilities: ["tools"], supportsVision: false, supportsToolUse: true }], options: [], defaultModel: "codex-model" }),
    harnessSettingsSource: store, executableDriverKinds: ["codex"], now: () => now,
  });
  return { service, native, observeIdentity, metadata, stored, config, save, setObservation: (value: CodexNativeAccountObservation) => { observation = value; } };
}

it("keeps discovered model display while identity observation is unavailable, without granting admission", async () => {
  const f = await fixture();
  const healthy = await f.service.getCatalog(principal, selection);
  expect(healthy.instances[0]?.availability).toBe("available");
  expect(validateChatProviderSelection({ catalog: healthy, selection })).toMatchObject({ ok: true });
  f.setObservation({ state: "unavailable", metadata: null });
  const checking = await f.service.getCatalog(principal, selection);
  expect(checking.instances[0]).toMatchObject({ availability: "unavailable", observationState: "checking", models: [{ id: "codex-model", availability: "unavailable" }] });
  expect(canonicalProviderAvailabilityLabel(checking.instances[0]!)).toBe("Checking Codex access…");
  const choices = deriveCanonicalProviderChoices(checking);
  expect(choices).toEqual([]);
  expect(deriveChatPickerModelRows(checking, choices)).toMatchObject([{ modelId: "codex-model", modelAvailability: "unavailable" }]);
  expect(deriveChatPickerModelRows(checking, choices)[0]?.choice).toBeUndefined();
  expect(validateChatProviderSelection({ catalog: checking, selection })).toMatchObject({ ok: false, error: { code: "provider_unavailable" } });
  f.setObservation({ state: "observed", metadata: f.metadata });
  const recovered = await f.service.getCatalog(principal, selection);
  expect(recovered.instances[0]).toMatchObject({ availability: "available", defaultSelection: selection });
  expect(recovered.instances[0]?.observationState).toBeUndefined();
  expect(f.observeIdentity).toHaveBeenCalledTimes(3);
  expect(f.native).not.toHaveBeenCalled();
});

it.each(["signed_out", "changed"] as const)("clears display and admission for confirmed %s identity", async state => {
  const f = await fixture();
  f.setObservation({ state, metadata: null });
  const catalog = await f.service.getCatalog(principal, selection);
  expect(catalog.instances[0]).toMatchObject({ availability: "unavailable", unavailabilityReason: "authentication_required", models: [] });
  expect(catalog.instances[0]?.observationState).toBeUndefined();
  expect(validateChatProviderSelection({ catalog, selection })).toMatchObject({ ok: false, error: { code: "provider_unavailable" } });
});

it.each(["signed_out", "changed"] as const)("does not label a confirmed %s during final private proof as checking", async state => {
  const f = await fixture();
  bindNativeAccountMetadata(f.metadata, async () => false, "unchanged-private-fixture-principal");
  Object.assign(f.native, { identityFailureState: () => state });
  const catalog = await f.service.getCatalog(principal, selection);
  expect(catalog.instances[0]).toMatchObject({ availability: "unavailable", unavailabilityReason: "authentication_required", models: [] });
  expect(catalog.instances[0]?.observationState).toBeUndefined();
  expect(validateChatProviderSelection({ catalog, selection })).toMatchObject({ ok: false });
});

it.each(["disabled", "consent", "principal"] as const)("does not recover authority after %s changes", async mode => {
  const f = await fixture();
  if (mode === "disabled") f.stored.enabled = false;
  if (mode === "consent") { delete f.stored.nativeAccountGeneration; delete f.stored.nativeAccountConsentRevision; }
  if (mode === "principal") f.setObservation({ state: "observed", metadata: bindNativeAccountMetadata({ ...f.metadata }, async () => true, "different-private-fixture-principal") });
  await f.save();
  const catalog = await f.service.getCatalog(principal, selection);
  expect(catalog.instances[0]?.availability).toBe("unavailable");
  expect(catalog.instances[0]?.models).toEqual([]);
  expect(catalog.instances[0]?.observationState).toBeUndefined();
  expect(validateChatProviderSelection({ catalog, selection })).toMatchObject({ ok: false, error: { code: "provider_unavailable" } });
});

it("negotiates checking without exposing a new field to strict legacy clients", async () => {
  const f = await fixture();
  f.setObservation({ state: "unavailable", metadata: null });
  const routes = createChatProviderRoutes({ catalog: f.service, getPrincipal: () => principal });
  const legacy = await (await routes.request("/api/chat-providers")).json();
  const modern = await (await routes.request("/api/chat-providers?includeObservationState=true")).json();
  const { observationState: _observation, ...legacyShape } = CanonicalProviderCatalogSchema.shape.instances.element.shape;
  const legacySchema = z.object(legacyShape).strict();
  const codex = (body: typeof legacy) => body.instances.find((row: { id: string }) => row.id === "codex_default");
  expect(legacySchema.safeParse(codex(legacy)).success).toBe(true);
  expect(codex(legacy).observationState).toBeUndefined();
  expect(codex(modern).observationState).toBe("checking");
  expect((await routes.request("/api/chat-providers?includeObservationState=invalid")).status).toBe(400);
  expect((await routes.request("/api/chat-providers?includeObservationState=true&includeObservationState=false")).status).toBe(400);
});


it("rejects checking descriptors that claim executable models or contradictory authority", async () => {
  const f = await fixture();
  f.setObservation({ state: "unavailable", metadata: null });
  const catalog = await f.service.getCatalog(principal, selection);
  const instance = catalog.instances[0]!;
  for (const changed of [
    { ...instance, availability: "available", unavailabilityReason: undefined },
    { ...instance, models: instance.models.map(model => ({ ...model, availability: "available" })) },
    { ...instance, driverKind: "pi" },
    { ...instance, unavailabilityReason: "authentication_required" },
  ]) expect(CanonicalProviderCatalogSchema.safeParse({ ...catalog, instances: [changed] }).success).toBe(false);
});
