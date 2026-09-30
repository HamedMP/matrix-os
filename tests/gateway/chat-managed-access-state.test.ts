import { describe, expect, it } from "vitest";
import { makeAiProviderSnapshot } from "../fixtures/ai-provider-snapshot.js";
import { managedChatInstances } from "../../packages/gateway/src/chat/managed-chat-catalog.js";

describe("Matrix AI Chat access state", () => {
  it("retains the real managed instance with credit-required state and no selectable models", () => {
    const snapshot = makeAiProviderSnapshot();
    snapshot.accessSources[0]!.state = "unavailable";
    snapshot.accessSources[0]!.safeReason = "credit_required";
    expect(managedChatInstances(snapshot, [])).toMatchObject([{ id: "kernel_matrix_included",
      driverKind: "kernel", connectionLabel: "Matrix AI", connectionState: "credit_required", availability: "unavailable", models: [] }]);
  });
  it("keeps expired readiness unavailable and never invents another execution route", () => {
    const snapshot = makeAiProviderSnapshot();
    snapshot.instances[0]!.readiness.staleAfter = "2026-08-29T21:00:01Z";
    expect(managedChatInstances(snapshot, [], Date.parse("2026-09-29T00:00:00Z"))).toMatchObject([
      { id: "kernel_matrix_included", connectionState: "unavailable", availability: "unavailable", models: [] },
    ]);
  });
});
