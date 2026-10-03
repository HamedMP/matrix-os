import { describe, expect, it } from "vitest";
import { CanonicalProviderCatalogSchema, managedPiBotModelChoices } from "@matrix-os/contracts";
import { makeAiProviderSnapshot } from "../fixtures/ai-provider-snapshot.js";
import { managedChatInstances, managedPiChatInstances } from "../../packages/gateway/src/chat/managed-chat-catalog.js";
import { resolveManagedPiRoute } from "../../packages/gateway/src/bots/route-resolver.js";

const now = Date.parse("2026-10-02T08:00:00.000Z");
function held() {
  const snapshot = makeAiProviderSnapshot();
  const readiness = { state: "unavailable" as const, checkedAt: new Date(now).toISOString(),
    staleAfter: "2026-10-02T08:00:05.000Z", safeReason: "credit_reserved" as const, action: "retry" as const };
  Object.assign(snapshot.accessSources[0]!, readiness);
  snapshot.instances[0]!.readiness = readiness;
  snapshot.instances[0]!.defaultModelId = null;
  return snapshot;
}
describe("managed catalog with reserved credit", () => {
  it("retains unavailable Sonnet descriptors through both owned Pi and legacy kernel without any executable default", () => {
    const snapshot = held();
    const instances = [...managedChatInstances(snapshot, [], now), ...managedPiChatInstances(snapshot, now)];
    expect(instances).toHaveLength(2);
    for (const instance of instances) {
      expect(instance).toMatchObject({ availability: "unavailable", connectionState: "credit_reserved",
        models: [{ id: "claude-sonnet-5", availability: "unavailable" }] });
      expect(instance.defaultSelection).toBeUndefined();
      expect(instance.setupActions).toEqual([{ id: "matrix_ai_settings", kind: "open_settings", label: "Agents & providers" }]);
    }
    const catalog = CanonicalProviderCatalogSchema.parse({ revision: "held", drivers: ["kernel", "matrix_pi"].map(kind => ({ kind, displayName: kind, adapterVersion: "1.0.0", capabilityClass: "system_agent" })),
      instances: instances.map(instance => ({ ...instance, catalogRevision: "held" })) });
    expect(managedPiBotModelChoices(catalog)).toEqual([]);
    expect(() => resolveManagedPiRoute(snapshot, { instanceId: "matrix_pi_default", model: "claude-sonnet-5" }, now)).toThrow("model_unavailable");
  });
  it.each(["unauthorized", "mismatched_source", "retired", "stale"])("never discovers %s models from static catalog alone", kind => {
    const snapshot = held();
    if (kind === "unauthorized") snapshot.accessSources[0]!.eligibleModelIds = [];
    if (kind === "mismatched_source") snapshot.models[0]!.eligibleAccessSourceIds = ["owner_anthropic_key"];
    if (kind === "retired") snapshot.models[0]!.status = "retired";
    if (kind === "stale") snapshot.accessSources[0]!.staleAfter = "2026-10-02T07:59:59.000Z";
    expect(managedPiChatInstances(snapshot, now)[0]!.models).toEqual([]);
  });
});
