import {expect,it} from "vitest";
import {BotCreationSeedResponseSchema,CreateManagedCustomBotRequestSchema} from "@matrix-os/contracts";
import {createBotRecipeCatalog} from "../../../packages/gateway/src/bots/recipe-catalog.js";
import {editableBotRecipeSeed} from "../../../packages/gateway/src/bots/recipe-creation-seed.js";
const ref={recipeId:"writing-bot",version:"2026-09-27.1"};
it("projects exact server template text/dependency intent without copying permissions or identity policy",()=>{
  const seed=editableBotRecipeSeed(createBotRecipeCatalog(),ref);
  expect(seed.recipe).toEqual(ref);
  expect(seed.editable).toBe(true);
  expect(seed.draft.instructions).toContain("draft and revise writing");
  expect(seed.draft).not.toHaveProperty("capabilities");expect(seed.draft).not.toHaveProperty("identitySource");
  expect(seed.draft.recipe?.skills).toEqual([]);
});
it("keeps templates with required apps fixed until their separate admission design is decided",()=>{
  const original=createBotRecipeCatalog().resolve(ref);
  const catalog=createBotRecipeCatalog([{...original,integrations:[{service:"gmail",effects:["read"],required:true}]}]);
  expect(editableBotRecipeSeed(catalog,ref).editable).toBe(false);
});
it("requires explicit seed eligibility instead of treating a missing field as editable",()=>{
  const seed=editableBotRecipeSeed(createBotRecipeCatalog(),ref);
  const {editable,...withoutEligibility}=seed;
  expect(editable).toBe(true);
  expect(BotCreationSeedResponseSchema.safeParse(withoutEligibility).success).toBe(false);
  expect(BotCreationSeedResponseSchema.safeParse({...withoutEligibility,editable:"true"}).success).toBe(false);
});
it("rejects retired/version-mismatched templates and owner-SOUL templates",()=>{
  expect(()=>editableBotRecipeSeed(createBotRecipeCatalog(),{...ref,version:"retired"})).toThrow();
  expect(()=>editableBotRecipeSeed(createBotRecipeCatalog(),{recipeId:"matrix-bot",version:"2026-10-10.1"})).toThrow();
});
it("accepts managed Matrix AI editable definitions with an exact template seed, never arbitrary account options",()=>{
  const input={name:"Edited template",description:"",instructions:"Use my changed procedure",selection:{instanceId:"matrix_pi_default",model:"current-model"},clientRequestId:"req_clone",seedRecipe:ref};
  expect(CreateManagedCustomBotRequestSchema.safeParse(input).success).toBe(true);
  expect(CreateManagedCustomBotRequestSchema.safeParse({...input,selection:{...input.selection,options:[{id:"accountId",value:"fake"}]}}).success).toBe(false);
});
