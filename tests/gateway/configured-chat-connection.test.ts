import { describe, expect, it } from "vitest";
import { CanonicalProviderInstanceDescriptorSchema } from "@matrix-os/contracts";
import { configuredHarnessInstanceFromAiSnapshot } from "../../packages/gateway/src/chat/configured-harness-catalog.js";
import { managedChatInstances } from "../../packages/gateway/src/chat/managed-chat-catalog.js";
import { deriveCanonicalProviderChoices } from "../../packages/ui/src/canonical-provider-choice.js";
import { makeAiProviderSnapshot } from "../fixtures/ai-provider-snapshot.js";

function input(kind: "pi" | "opencode" = "pi") {
  const snapshot = makeAiProviderSnapshot();
  return {
    instance: { ...managedChatInstances(snapshot, [])[0]!, id: `${kind}_default`, driverKind: kind, displayName: kind },
    harness: { accessSourceId: "source_a", route: { kind: "configurable" as const, providerId: "anthropic", modelId: "claude-sonnet-5" } },
    aiSnapshot: snapshot,
    settings: { modelProviders: [], accessSources: [{ id: "source_a", kind: "matrix_gateway" as const }] },
  };
}

describe("canonical Chat connection presentation", () => {
  it.each(["pi", "opencode"] as const)("projects %s's selected Matrix connection without changing the route", (kind) => {
    const before = input(kind);
    const result = configuredHarnessInstanceFromAiSnapshot(before);
    expect(result).toMatchObject({ id: `${kind}_default`, displayName: kind, connectionLabel: "Matrix AI",
      availability: "available", defaultSelection: { instanceId: `${kind}_default`, model: "anthropic:claude-sonnet-5" } });
    const instance = CanonicalProviderInstanceDescriptorSchema.parse({ ...result, catalogRevision: "revision" });
    expect(deriveCanonicalProviderChoices({ revision: "revision", drivers: [], instances: [instance] })[0])
      .toMatchObject({ instanceId: `${kind}_default`, connectionLabel: "Matrix AI" });
  });
  it("uses the exact source rather than another Matrix source or the instance label", () => {
    const before = input();
    const result = configuredHarnessInstanceFromAiSnapshot({ ...before, instance: { ...before.instance, displayName: "Matrix AI" },
      settings: { ...before.settings, accessSources: [{ id: "source_a", kind: "provider_account" }, { id: "other", kind: "matrix_gateway" }] } });
    expect(result.connectionLabel).toBe("Own account");
    expect(configuredHarnessInstanceFromAiSnapshot({ ...before, harness: { ...before.harness, accessSourceId: "missing" } }).connectionLabel).toBeUndefined();
  });
  it("does not make an unavailable model ready through connection labeling", () => {
    const before = input();
    before.aiSnapshot.models[0]!.status = "unavailable";
    expect(configuredHarnessInstanceFromAiSnapshot(before)).toMatchObject({ availability: "unavailable", models: [] });
  });
  it("keeps labels optional and bounds the public contract", () => {
    const base = { ...configuredHarnessInstanceFromAiSnapshot(input()), connectionLabel: undefined, catalogRevision: "revision" };
    expect(CanonicalProviderInstanceDescriptorSchema.safeParse(base).success).toBe(true);
    expect(CanonicalProviderInstanceDescriptorSchema.safeParse({ ...base, connectionLabel: "Matrix AI" }).success).toBe(true);
    expect(CanonicalProviderInstanceDescriptorSchema.safeParse({ ...base, connectionLabel: "x".repeat(161) }).success).toBe(false);
  });
});
