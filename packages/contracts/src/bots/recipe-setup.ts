import { z } from "zod/v4";
import { BotRecipeSummarySchema } from "#bots/bot";
import { BotToolCapabilitySchema } from "#bots/broker";
import { BotEffectListSchema } from "#bots/grants";
import { BotIntegrationServiceSchema } from "#bots/ids";
import { canonicalBoundedText, canonicalReferenceId } from "#canonical-chat-primitives";

/** Editable defaults and declared requirements, independent of any owner's connections. */
export const BotRecipeSetupContextSchema = BotRecipeSummarySchema.extend({
  instructions: canonicalBoundedText(8_000, 24 * 1024),
  capabilities: z.array(BotToolCapabilitySchema).max(16),
  skills: z.array(canonicalReferenceId()).max(32),
  integrations: z.array(z.object({
    service: BotIntegrationServiceSchema,
    effects: BotEffectListSchema,
    required: z.boolean(),
  }).strict()).max(8),
  mcpServers: z.array(canonicalReferenceId()).max(32),
}).strict();
export type BotRecipeSetupContext = z.infer<typeof BotRecipeSetupContextSchema>;
