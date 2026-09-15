import { describe, expect, it } from "vitest";
import { makeAiProviderSnapshot } from "../fixtures/ai-provider-snapshot.js";
import { managedChatInstances } from "../../packages/gateway/src/chat/managed-chat-catalog.js";

describe("managed Chat catalog", () => {
  it("projects the ready managed route without inventing an agent or account", () => {
    const [instance] = managedChatInstances(makeAiProviderSnapshot(), []);
    expect(instance).toMatchObject({
      id: "kernel_matrix_included", driverKind: "kernel", displayName: "Matrix AI",
      availability: "available", defaultSelection: {
        instanceId: "kernel_matrix_included", model: "claude-sonnet-5",
      },
    });
    expect(instance?.models.map((model) => model.id)).toEqual(["claude-sonnet-5"]);
  });

  it.each(["setup_required", "unavailable", "unknown", "expired"] as const)("hides a %s access source", (state) => {
    const snapshot = makeAiProviderSnapshot();
    snapshot.accessSources[0]!.state = state;
    expect(managedChatInstances(snapshot, [])).toEqual([]);
  });

  it("hides stale relay readiness and unavailable instances", () => {
    const snapshot = makeAiProviderSnapshot();
    snapshot.accessSources[0]!.staleAfter = "2000-01-01T00:00:00.000Z";
    expect(managedChatInstances(snapshot, [])).toEqual([]);
    snapshot.accessSources[0]!.staleAfter = null;
    snapshot.instances[0]!.readiness.state = "unavailable";
    expect(managedChatInstances(snapshot, [])).toEqual([]);
  });

  it("intersects the model and source policies without silently replacing a saved model", () => {
    const snapshot = makeAiProviderSnapshot();
    snapshot.instances[0]!.defaultModelId = null;
    expect(managedChatInstances(snapshot, [])[0]?.defaultSelection).toBeUndefined();
    snapshot.accessSources[0]!.eligibleModelIds = [];
    expect(managedChatInstances(snapshot, [])).toEqual([]);
  });

  it("does not invent readiness without a snapshot or a matching managed source", () => {
    expect(managedChatInstances(undefined, [])).toEqual([]);
    const snapshot = makeAiProviderSnapshot();
    snapshot.accessSources = [];
    expect(managedChatInstances(snapshot, [])).toEqual([]);
  });
});
