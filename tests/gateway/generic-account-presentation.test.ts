import { describe, expect, it } from "vitest";
import { nativeAccountPresentationFixture } from "./generic-account-presentation-fixture.js";

describe("native harness account identity projection", () => {
  it.each(["pi", "opencode"] as const)("does not attach Codex account to %s through OpenAI provider membership", async (harness) => {
    const snapshot = await nativeAccountPresentationFixture(harness);
    expect(snapshot.accounts.find((account) => account.id === "owner_codex")).toBeDefined();
    expect(snapshot.harnesses[0]).toMatchObject({ accountIds: [], selectedAccountId: null,
      accessSourceId: `harness_${harness}_openai`, authState: "unknown", connectivity: "unknown", configuredEnabled: true, enabled: true });
    expect(snapshot.accessSources.find((source) => source.id === `harness_${harness}_openai`))
      .toMatchObject({ kind: "harness_profile", accountId: null, readiness: { state: "unknown" }, localObservation: { state: "present_unverified" } });
  });
});
