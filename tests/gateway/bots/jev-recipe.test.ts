import { Hono } from "hono";
import { createBotRoutes } from "../../../packages/gateway/src/bots/routes.js";
import { MissingRequestPrincipalError } from "../../../packages/gateway/src/request-principal.js";
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

it.each(["user_new_owner", "user_existing_owner"])("publishes Jev for any authenticated owner without service or funding lookup: %s", async userId => {
  const app = new Hono().route("/", createBotRoutes({
    recipes: createBotRecipeCatalog(), getPrincipal: () => ({ userId, source: "jwt" }) as never,
  }));
  const response = await app.request("/api/chat-agents/bot-recipes");
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  const { recipes } = await response.json();
  expect(recipes.filter((r: { recipeId: string }) => r.recipeId === "jev-inbox-triage")).toEqual([
    expect.objectContaining({ name: "Jev Inbox Triage", version: "2026-10-06.1" }),
  ]);
  expect(JSON.stringify(recipes)).not.toContain("instructions");
});
it("keeps recipe discovery authenticated", async () => {
  const app = new Hono().route("/", createBotRoutes({ recipes: createBotRecipeCatalog(),
    getPrincipal: () => { throw new MissingRequestPrincipalError(); },
  }));
  expect((await app.request("/api/chat-agents/bot-recipes")).status).toBe(401);
});
