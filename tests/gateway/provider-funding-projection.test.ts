import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AiProviderReadiness } from "@matrix-os/contracts";
import { AiProviderService } from "../../packages/gateway/src/ai-providers/service.js";
import { initialProviderSettingsConfiguration } from "../../packages/gateway/src/ai-providers/provider-settings-persistence.js";
import { projectProviderSettings } from "../../packages/gateway/src/ai-providers/provider-settings-projector.js";
import { managedPiChatInstances } from "../../packages/gateway/src/chat/managed-chat-catalog.js";
import { readProviderSettingsEnrichment } from "../../packages/gateway/src/ai-providers/provider-settings-enrichment.js";

const now = new Date("2026-10-02T08:00:00.000Z");
describe("owner-funded discovery projection", () => {
  it("adds a configured healthy Bedrock model to Provider V3 through the Matrix relay path", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "provider-bedrock-model-"));
    const readiness: AiProviderReadiness = { state: "ready", checkedAt: now.toISOString(),
      staleAfter: "2026-10-02T08:00:30.000Z", action: "none", safeReason: null };
    const service = new AiProviderService({ homePath, now: () => now,
      fundedCredentialProvider: { enabled: true, maxRunMs: 600_000,
        getCredential: vi.fn(), invalidate: () => {}, close: () => {} },
      driverInventory: async () => [],
      fundedReadinessReader: { read: async () => ({ readiness,
        allowedModelIds: ["claude-opus-5"], discoverableModelIds: ["claude-opus-5"],
        upstreamPreference: {
          selectedUpstream: "aws_bedrock", effectiveUpstream: "aws_bedrock",
          effectiveBedrockModelIds: ["anthropic/claude-opus-5"], revision: 2,
          updatedAt: now.toISOString(), validThrough: "2026-10-31T00:00:00.000Z",
        },
      }) } });
    try {
      const canonical = await service.getSnapshot();
      expect(canonical.models.find(model => model.id === "claude-opus-5")).toMatchObject({
        vendor: "anthropic",
        eligibleAccessSourceIds: expect.arrayContaining(["matrix_included"]),
        dataPolicies: expect.arrayContaining([{
          accessSourceId: "matrix_included", route: "matrix_relay",
          disclosureKey: "matrix-cloudflare-anthropic",
        }]),
      });
      expect(canonical.accessSources.find(source => source.id === "matrix_included"))
        .toMatchObject({ state: "ready", eligibleModelIds: ["claude-opus-5"] });
      expect(canonical.upstreamPreference).toMatchObject({
        effectiveUpstream: "aws_bedrock", effectiveBedrockModelIds: ["anthropic/claude-opus-5"],
      });
      expect(canonical.instances.find(instance => instance.id === "kernel_matrix_included"))
        .toMatchObject({ modelIds: [], defaultModelId: null });
      expect(managedPiChatInstances(canonical, now.getTime())[0]?.models)
        .toContainEqual(expect.objectContaining({ id: "claude-opus-5", availability: "available" }));
    } finally { service.close(); await rm(homePath, { recursive: true, force: true }); }
  });

  it("projects the platform-authoritative upstream preference only for an entitled owner", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "provider-upstream-preference-"));
    const service = new AiProviderService({ homePath, now: () => now, driverInventory: async () => [] });
    try {
      const canonical = await service.getSnapshot();
      const preference = {
        selectedUpstream: "aws_bedrock" as const,
        effectiveUpstream: "cloudflare" as const,
        effectiveBedrockModelIds: [],
        revision: 3,
        updatedAt: "2026-10-02T07:59:00.000Z",
        validThrough: "2026-10-31T00:00:00.000Z",
      };
      const funding = { asOf: now.toISOString(), periodStart: "2026-10-01T00:00:00.000Z", monthlyBudgetMicrousd: 2_000_000,
        settledThisMonthMicrousd: 0, reservedMicrousd: 0, reservedThisMonthMicrousd: 0, promotionalBalanceMicrousd: 1_000_000,
        addonBalanceMicrousd: 0, creditBalanceMicrousd: 1_000_000, remainingBalanceMicrousd: 1_000_000, remainingBudgetMicrousd: 2_000_000 };
      const policy = { enabled: true, globalRevision: 1, runtimeRevision: 1, allowedModelIds: [], monthlyBudgetMicrousd: 2_000_000,
        checkedAt: now.toISOString(), staleAfter: "2026-10-02T08:01:00.000Z" };
      const enrichment = await readProviderSettingsEnrichment({ canonical, refresh: false, catalogFailureHarnesses: [],
        fundingSummary: { getFundingSummary: async () => ({ funding, policy, upstreamPreference: preference }) } });
      const settings = await projectProviderSettings({ canonical, config: initialProviderSettingsConfiguration(canonical), now,
        supportedActions: ["set_gateway_upstream"], fundedPolicyAuthoritative: true, ...enrichment });
      expect(settings.upstreamPreference).toEqual(preference);
      expect(settings.supportedActions).toContain("set_gateway_upstream");
    } finally { service.close(); await rm(homePath, { recursive: true, force: true }); }
  });

  it("carries negotiated speech-only observation from funding reader into shared Settings without changing total credit", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "provider-chat-credit-"));
    const service = new AiProviderService({ homePath, now: () => now, driverInventory: async () => [] });
    try {
      const canonical = await service.getSnapshot();
      const funding = { asOf: now.toISOString(), periodStart: "2026-10-01T00:00:00.000Z", monthlyBudgetMicrousd: 2_000_000,
        settledThisMonthMicrousd: 0, reservedMicrousd: 0, reservedThisMonthMicrousd: 0, promotionalBalanceMicrousd: 1_000_000,
        addonBalanceMicrousd: 0, creditBalanceMicrousd: 1_000_000, remainingBalanceMicrousd: 1_000_000, remainingBudgetMicrousd: 2_000_000 };
      const policy = { enabled: true, globalRevision: 1, runtimeRevision: 1, allowedModelIds: [], monthlyBudgetMicrousd: 2_000_000,
        checkedAt: now.toISOString(), staleAfter: "2026-10-02T08:01:00.000Z" };
      const chatAvailability = { contractVersion: 1 as const, asOf: now.toISOString(), eligibleBalanceMicrousd: 0, availableBalanceMicrousd: 0 };
      const enrichment = await readProviderSettingsEnrichment({ canonical, refresh: false, catalogFailureHarnesses: [],
        fundingSummary: { getFundingSummary: async () => ({ funding, policy, chatAvailability }) } });
      const settings = await projectProviderSettings({ canonical, config: initialProviderSettingsConfiguration(canonical), now,
        supportedActions: [], fundedPolicyAuthoritative: true, ...enrichment });
      expect(settings.accessSources.find(source => source.kind === "matrix_gateway")?.usage).toMatchObject({
        kind: "managed_credit", remainingMicrousd: 1_000_000, chatAvailability: { availableBalanceMicrousd: 0 } });
    } finally { service.close(); await rm(homePath, { recursive: true, force: true }); }
  });
  it.each(["credit_reserved", "provider_unavailable"] as const)("retains only authorized mapped models when %s prevents execution", async safeReason => {
    const homePath = await mkdtemp(join(tmpdir(), "provider-funding-projection-"));
    const acquire = vi.fn(async () => { throw new Error("Discovery must not acquire credentials"); });
    const readiness: AiProviderReadiness = { state: "unavailable", checkedAt: now.toISOString(),
      staleAfter: "2026-10-02T08:00:30.000Z", action: "retry", safeReason };
    const service = new AiProviderService({ homePath, now: () => now,
      fundedCredentialProvider: { enabled: true, maxRunMs: 600_000, getCredential: acquire, invalidate: () => {}, close: () => {} },
      driverInventory: async () => [],
      fundedReadinessReader: { read: async () => ({ readiness, allowedModelIds: [],
        discoverableModelIds: ["claude-sonnet-5", "unsupported/owner-policy-model"] }) } });
    try {
      const canonical = await service.getSnapshot();
      expect(canonical.accessSources.find(source => source.id === "matrix_included")).toMatchObject({
        state: "unavailable", safeReason, eligibleModelIds: ["claude-sonnet-5"] });
      expect(canonical.accessSources.find(source => source.id === "matrix_cloudflare")).toMatchObject({
        state: "unavailable", safeReason: "provider_unavailable", eligibleModelIds: [] });
      expect(canonical.active.providerInstanceId).toBeNull();
      expect(canonical.instances.find(instance => instance.id === "kernel_matrix_included")).toMatchObject({
        modelIds: ["claude-sonnet-5"], defaultModelId: null });
      const pi = managedPiChatInstances(canonical, now.getTime())[0]!;
      expect(pi).toMatchObject({ availability: "unavailable", models: [{ id: "claude-sonnet-5", availability: "unavailable" }] });
      expect(pi.defaultSelection).toBeUndefined();
      const config = initialProviderSettingsConfiguration(canonical);
      const settings = await projectProviderSettings({ canonical, config, now, supportedActions: [],
        fundedPolicyAuthoritative: true, fundedPolicy: { enabled: true, globalRevision: 4, runtimeRevision: 2,
          allowedModelIds: ["anthropic/claude-sonnet-5"], monthlyBudgetMicrousd: 5_100_000,
          checkedAt: now.toISOString(), staleAfter: "2026-10-02T08:01:00.000Z" } });
      expect(settings.accessSources.find(source => source.id === "matrix_included")).toMatchObject({
        readiness: { state: "unavailable", safeReason }, eligibleModelIds: ["claude-sonnet-5"] });
      expect(settings.gatewayPolicy?.allowedModelIds).toEqual(["claude-sonnet-5"]);
      expect(acquire).not.toHaveBeenCalled();
    } finally { service.close(); await rm(homePath, { recursive: true, force: true }); }
  });
});
