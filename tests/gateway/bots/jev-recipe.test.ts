import { expect, it } from "vitest";
import { createBotRecipeCatalog } from "../../../packages/gateway/src/bots/recipe-catalog.js";
it("advertises one executable Jev recipe with scoped label authority", () => {
  const recipes = createBotRecipeCatalog().list().filter(r => r.recipeId === "jev-inbox-triage");
  expect(recipes).toHaveLength(1);
  expect(recipes[0]?.name).toBe("Jev Inbox Triage");
  expect(recipes[0]?.capabilities).toContain("jev.inbox");
  expect(recipes[0]?.capabilities).not.toContain("integration.call");
  expect(recipes[0]?.integrations).toEqual([{ service: "gmail", effects: ["read", "label"], required: true }]);
});
it("retains old Pi Inbox definitions without silently granting labeling", () => {
  const old = createBotRecipeCatalog().resolve({ recipeId: "jev-inbox-triage", version: "2026-09-28.1" });
  expect(old.integrations[0]?.effects).toEqual(["read"]);
  expect(old.capabilities).not.toContain("jev.inbox");
  expect(old.instructions).toContain("never change anything");
});
