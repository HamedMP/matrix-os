import { describe, expect, it } from "vitest";
import { makeAiProviderSnapshot } from "../fixtures/ai-provider-snapshot.js";
import { managedChatInstances } from "../../packages/gateway/src/chat/managed-chat-catalog.js";

function expectUnavailableManagedRoute(snapshot: ReturnType<typeof makeAiProviderSnapshot>) {
  const instances = managedChatInstances(snapshot, []);
  expect(instances).toHaveLength(1);
  expect(instances[0]).toMatchObject({
    id: "kernel_matrix_included", connectionLabel: "Matrix AI",
    availability: "unavailable", connectionState: "unavailable", models: [], options: [],
  });
  expect(instances[0]?.defaultSelection).toBeUndefined();
}

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

  it.each(["setup_required", "unavailable", "unknown", "expired"] as const)("retains a non-runnable Matrix AI route for a %s access source", (state) => {
    const snapshot = makeAiProviderSnapshot();
    snapshot.accessSources[0]!.state = state;
    expectUnavailableManagedRoute(snapshot);
  });

  it("keeps stale relay readiness and unavailable instances non-runnable", () => {
    const snapshot = makeAiProviderSnapshot();
    snapshot.accessSources[0]!.staleAfter = "2000-01-01T00:00:00.000Z";
    expectUnavailableManagedRoute(snapshot);
    snapshot.accessSources[0]!.staleAfter = null;
    snapshot.instances[0]!.readiness.state = "unavailable";
    expectUnavailableManagedRoute(snapshot);
  });

  it("intersects the model and source policies without silently replacing a saved model", () => {
    const snapshot = makeAiProviderSnapshot();
    snapshot.instances[0]!.defaultModelId = null;
    expect(managedChatInstances(snapshot, [])[0]?.defaultSelection).toBeUndefined();
    snapshot.accessSources[0]!.eligibleModelIds = [];
    expectUnavailableManagedRoute(snapshot);
  });

  it("does not invent readiness without a snapshot or a matching managed source", () => {
    expect(managedChatInstances(undefined, [])).toEqual([]);
    const snapshot = makeAiProviderSnapshot();
    snapshot.accessSources = [];
    expect(managedChatInstances(snapshot, [])).toEqual([]);
  });
});
