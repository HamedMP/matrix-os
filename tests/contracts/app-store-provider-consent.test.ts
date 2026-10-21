import { describe, expect, it } from "vitest";
import { AppStoreStatusSchema } from "../../packages/contracts/src/app-store";
import { AppStoreCreateDraftSchema, AppStoreReviseDraftSchema } from "../../packages/contracts/src/app-store-gateway";

describe("provider-specific draft consent", () => {
  it("binds draft creation and revision to the disclosed access source", () => {
    const aiConsent = { accessSourceId: "owner_anthropic_key" };
    expect(AppStoreCreateDraftSchema.parse({ app: "habit-garden", aiConsent }).aiConsent).toEqual(aiConsent);
    expect(AppStoreReviseDraftSchema.parse({ instructions: "Generalize branding", aiConsent }).aiConsent).toEqual(aiConsent);
    expect(AppStoreCreateDraftSchema.parse({ app: "habit-garden" }).aiConsent).toBeUndefined();
    expect(AppStoreCreateDraftSchema.safeParse({ app: "habit-garden", aiConsent: { accessSourceId: "" } }).success).toBe(false);
  });
  it("describes the actual AI access before asking for consent", () => {
    const generalizer = { available: true, label: "Anthropic (your API key)", accessSourceId: "owner_anthropic_key" };
    expect(AppStoreStatusSchema.parse({ enabled: true, reviewer: false, generalizer }).generalizer).toEqual(generalizer);
  });
});
