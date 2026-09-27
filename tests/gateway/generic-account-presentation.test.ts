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
  it.each(["pi", "opencode"] as const)("does not attach Codex account to %s after a failed native catalog", async (harness) => {
    const snapshot = await nativeAccountPresentationFixture(harness, true);
    expect(snapshot.accounts.find((account) => account.id === "owner_codex")).toBeDefined();
    expect(snapshot.harnesses[0]).toMatchObject({ accountIds: [], selectedAccountId: null,
      accessSourceId: null, configuredAccessSourceId: `harness_${harness}_openai`,
      authState: "unknown", configuredEnabled: true, enabled: false, routeAvailability: "catalog_unavailable",
      route: { providerId: "openai", modelId: "openai:fixture-sol" } });
    expect(snapshot.accessSources.find((source) => source.id === `harness_${harness}_openai`)).toBeUndefined();
  });
  it.each([false, true])("retains the supported Codex provider-account binding when native catalog failure is %s", async (failed) => {
    const snapshot = await nativeAccountPresentationFixture("opencode", failed);
    expect(snapshot.harnesses.find((harness) => harness.harness === "codex"))
      .toMatchObject({ accountIds: ["owner_codex"], selectedAccountId: "owner_codex", accessSourceId: "owner_openai_profile", authState: "unknown" });
  });
});
