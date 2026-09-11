import { z } from "zod/v4";
import { canonicalBoundedText, canonicalReferenceId, canonicalSafeLabel } from "#canonical-chat-primitives";

// Membership belongs to the current computer's catalogue, not a client enum.
export const ChatAgentRecipeSkillIdSchema = canonicalReferenceId(160);
export const CHAT_AGENT_RECIPE_MAX_SKILLS = 8;
export const CHAT_AGENT_RECIPE_MAX_CATALOG_SKILLS = 256;
export const CHAT_AGENT_RECIPE_MAX_INSTRUCTION_BYTES = 24 * 1024;
const ServiceIdSchema = z.string().min(1).max(80).regex(/^[a-z][a-z0-9_]{0,79}$/);
const AccountLabelSchema = z.string().trim().min(1).max(100)
  .refine((value) => new TextEncoder().encode(value).byteLength <= 400, { message: "Account label exceeds byte limit" });
const RecipeIntegrationSchema = z.object({
  service: ServiceIdSchema,
  accountLabel: AccountLabelSchema.optional(),
}).strict();
const RecipeOutputSchema = canonicalBoundedText(1_000, 4_000);

function hasUniqueSkills(value: { skills: readonly string[] }): boolean {
  return new Set(value.skills).size === value.skills.length;
}

function hasUniqueIntegrations(value: { integrations: readonly { service: string; accountLabel?: string }[] }): boolean {
  const keys = value.integrations.map(({ service, accountLabel }) => `${service}\0${accountLabel ?? ""}`);
  return new Set(keys).size === keys.length;
}

export const ChatAgentRecipeSchema = z.object({
  skills: z.array(ChatAgentRecipeSkillIdSchema).max(CHAT_AGENT_RECIPE_MAX_SKILLS),
  integrations: z.array(RecipeIntegrationSchema).max(8),
  output: RecipeOutputSchema,
}).strict()
  .refine(hasUniqueSkills, { message: "Recipe skills must be unique", path: ["skills"] })
  .refine(hasUniqueIntegrations, { message: "Recipe integrations must be unique", path: ["integrations"] });

const CatalogSkillSchema = z.object({
  id: ChatAgentRecipeSkillIdSchema,
  name: canonicalSafeLabel(120, 480),
  description: canonicalSafeLabel(400, 1_600),
  instructionBytes: z.number().int().min(1).max(CHAT_AGENT_RECIPE_MAX_INSTRUCTION_BYTES).optional(),
}).strict();
const CatalogServiceSchema = z.object({
  id: ServiceIdSchema,
  name: canonicalSafeLabel(120, 480),
}).strict();

export const ChatAgentRecipeCatalogSchema = z.object({
  enabled: z.boolean(),
  skills: z.array(CatalogSkillSchema).max(CHAT_AGENT_RECIPE_MAX_CATALOG_SKILLS),
  services: z.array(CatalogServiceSchema).max(128),
}).strict();

export const ResolvedChatAgentRecipeSchema = z.object({
  skills: z.array(z.object({
    id: ChatAgentRecipeSkillIdSchema,
    name: canonicalSafeLabel(120, 480),
    instructions: canonicalBoundedText(24 * 1024, 24 * 1024),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict()).max(CHAT_AGENT_RECIPE_MAX_SKILLS),
  integrations: z.array(RecipeIntegrationSchema).max(8),
  output: RecipeOutputSchema,
}).strict()
  .refine((value) => new Set(value.skills.map((skill) => skill.id)).size === value.skills.length, {
    message: "Resolved recipe skills must be unique",
    path: ["skills"],
  })
  .refine(hasUniqueIntegrations, { message: "Resolved recipe integrations must be unique", path: ["integrations"] })
  .refine((value) => value.skills.reduce(
    (bytes, skill) => bytes + new TextEncoder().encode(skill.instructions).byteLength,
    0,
  ) <= CHAT_AGENT_RECIPE_MAX_INSTRUCTION_BYTES, { message: "Resolved recipe instructions exceed their byte limit", path: ["skills"] });

export type ChatAgentRecipe = z.infer<typeof ChatAgentRecipeSchema>;
export type ChatAgentRecipeCatalog = z.infer<typeof ChatAgentRecipeCatalogSchema>;
export type ResolvedChatAgentRecipe = z.infer<typeof ResolvedChatAgentRecipeSchema>;
