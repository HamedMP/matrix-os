import { describe, expect, it } from "vitest";
import type { CanonicalProviderInstanceDescriptor, ProviderAccessSource, ProviderHarnessInstance, ProviderSettingsSnapshot } from "@matrix-os/contracts";
import { configuredHarnessInstanceFromAiSnapshot } from "../../packages/gateway/src/chat/configured-harness-catalog.js";

function fixture(kind: "pi" | "opencode") {
  const providerId = kind === "pi" ? "openai-codex" : "openai";
  const ids = ["gpt-5.6-sol", "gpt-6-sol", "gpt-6-astra", "not-eligible", "disabled"].map(id => `${providerId}:${id}`);
  const harness = { harness: kind, accessSourceId: `harness_${kind}_${providerId}`,
    route: { kind: "configurable", providerId, modelId: ids[0]! } } satisfies Pick<ProviderHarnessInstance, "harness" | "route" | "accessSourceId">;
  const source: ProviderAccessSource = {
    id: harness.accessSourceId, kind: "harness_profile", harness: kind, providerId, accountId: null,
    fundingKind: "owner_account", displayName: `${kind} account`, eligibleModelIds: ids.filter(id => !id.endsWith("not-eligible")),
    readiness: { state: "unknown", checkedAt: null, staleAfter: null, action: "retry", safeReason: "unknown" },
    localObservation: { state: "present_unverified", checkedAt: "2026-09-29T00:00:00Z", staleAfter: "2026-09-29T00:00:05Z" },
    usage: { kind: "unavailable", authority: "unavailable", state: "not_applicable", scope: "access_source", reason: "provider_does_not_report", asOf: null },
  };
  const instance: Omit<CanonicalProviderInstanceDescriptor, "catalogRevision"> = {
    id: `${kind}_default`, driverKind: kind, displayName: kind, availability: "available", workspaceRequirement: "project_optional",
    models: [], options: [], skills: [], commands: [], setupActions: [],
    supports: { rootChat: true, resume: true, cancellation: true, attachments: [], tools: [], approvals: false,
      userInput: false, worktrees: "none", resources: [], interactionModes: ["default"], permissionModes: ["full_access"] },
  };
  const settings: Pick<ProviderSettingsSnapshot, "modelProviders" | "accessSources"> = {
    accessSources: [source], modelProviders: [{ id: providerId, displayName: "Codex subscription",
      models: ids.map(id => ({ id, displayName: id, enabled: !id.endsWith("disabled") })) },
      { id: "anthropic", displayName: "Anthropic", models: [{ id: "anthropic:claude-sonnet-5", displayName: "Sonnet", enabled: true }] }],
  };
  return { instance, harness, settings, ids, source };
}

describe("Chat native subscription inventory", () => {
  it.each(["pi", "opencode"] as const)("retains every eligible discovered %s model while keeping the saved default", kind => {
    const input = fixture(kind);
    const projected = configuredHarnessInstanceFromAiSnapshot(input);
    expect(projected.models.map(model => model.id)).toEqual(input.ids.slice(0, 3));
    expect(projected.defaultSelection).toEqual({ instanceId: input.instance.id, model: input.ids[0] });
    expect(projected.localObservation).toEqual(input.source.localObservation);
    expect(projected.connectionLabel).toBe("Own account");
  });
  it.each(["pi", "opencode"] as const)("fails closed when the %s saved model is outside its exact source", kind => {
    const input = fixture(kind);
    input.source.eligibleModelIds = input.ids.slice(1, 3);
    expect(configuredHarnessInstanceFromAiSnapshot(input).availability).toBe("unavailable");
  });
  it("does not broaden a managed route from an unrelated native inventory", () => {
    const input = fixture("pi");
    input.settings.accessSources = [{ ...input.source, kind: "matrix_gateway", harness: undefined, fundingKind: "matrix_included" }];
    expect(configuredHarnessInstanceFromAiSnapshot(input).models.map(model => model.id)).toEqual([input.ids[0]]);
  });
  it("does not use another harness's model inventory", () => {
    const input = fixture("pi");
    input.source.harness = "opencode";
    expect(configuredHarnessInstanceFromAiSnapshot(input).availability).toBe("unavailable");
  });
  it("bounds a large native catalog while retaining its actual saved default", () => {
    const input = fixture("pi");
    const models = Array.from({ length: 70 }, (_, i) => ({ id: `openai-codex:model-${i}`, displayName: `Model ${i}`, enabled: true }));
    input.settings.modelProviders[0]!.models = models;
    input.source.eligibleModelIds = models.map(model => model.id);
    input.harness.route.modelId = models.at(-1)!.id;
    const result = configuredHarnessInstanceFromAiSnapshot(input);
    expect(result.models).toHaveLength(64);
    expect(result.models.some(model => model.id === input.harness.route.modelId)).toBe(true);
    expect(result.defaultSelection?.model).toBe(input.harness.route.modelId);
  });
});
