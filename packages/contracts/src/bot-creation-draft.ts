import { z } from "zod/v4";
import { canonicalBoundedText, canonicalEncodedByteLength, canonicalReferenceId, canonicalSafeLabel } from "#canonical-chat-primitives";
import { CanonicalChatModelSelectionSchema } from "#canonical-chat-selection";
import { ChatAgentRecipeSchema } from "#chat-agent-recipe";

const incompleteText = (chars: number, bytes: number) => z.string().max(chars)
  .refine(value => new TextEncoder().encode(value).byteLength <= bytes, { message: "Draft text exceeds byte limit" });
// Drafts may be incomplete; owner Create applies the existing required-field/catalog checks.
const DraftRecipeSchema = ChatAgentRecipeSchema.safeExtend({ output: incompleteText(1_000, 4_000) });
export const BotCreationDraftSchema = z.object({
  name: incompleteText(80, 320),
  description: incompleteText(400, 1_600),
  instructions: incompleteText(8_000, 24 * 1024),
  selection: CanonicalChatModelSelectionSchema.nullable(),
  recipe: DraftRecipeSchema.nullable().optional(),
  taskExecutor: z.object({ connectionId: z.literal("claude_code_tasks"), model: canonicalReferenceId(128).nullable() }).strict().nullable().optional(),
  coordinatorInstanceId: canonicalReferenceId(128).nullable().optional(),
}).strict();
export const BotCreationDraftPatchSchema = BotCreationDraftSchema.pick({ name: true, description: true, instructions: true, recipe: true }).partial()
  .refine(value => Object.keys(value).length > 0, { message: "Draft patch must change a field" })
  .refine(value => value.recipe?.jevInboxLabeling !== true, { message: "Model proposals cannot grant inbox labeling" });

export const BOT_SETTINGS_PROPOSAL_ACTIVITY_ID = "bot_settings_proposal";
/** A direct Bot can propose text fields. The owner manages access and execution settings. */
export const BotSavedSettingsPatchSchema = z.object({
  name: canonicalSafeLabel(80, 320).optional(),
  description: BotCreationDraftSchema.shape.description.optional(),
  instructions: canonicalBoundedText(8_000, 24 * 1024).optional(),
}).strict().refine(patch => Object.keys(patch).length > 0, { message: "Choose a setting to change" });
export type BotSavedSettingsPatch = z.infer<typeof BotSavedSettingsPatchSchema>;

/** A navigation suggestion conveys no credentials, destination URL, or access. */
export const BotConnectionRequestSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("integration"), service: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/) }),
  z.strictObject({ kind: z.literal("mcp"), name: canonicalSafeLabel(80, 320).optional() }),
]);
export type BotConnectionRequest = z.infer<typeof BotConnectionRequestSchema>;
export const BotConnectionRequestInputSchema = z.strictObject({ resource: BotConnectionRequestSchema });
export const BotSettingsProposalInputSchema = z.union([
  z.strictObject({ patch: BotSavedSettingsPatchSchema }), BotConnectionRequestInputSchema,
]);
export type BotSettingsProposalInput = z.infer<typeof BotSettingsProposalInputSchema>;
export const BOT_CONNECTION_REQUEST_ACTIVITY_ID = "bot_connection_request";

export function readBotConnectionRequest(activity: { type: string; resource?: unknown }): BotConnectionRequest | null {
  if (activity.type !== "bot.connection.requested") return null;
  const result = BotConnectionRequestSchema.safeParse(activity.resource);
  return result.success ? result.data : null;
}


export const BotCreationSnapshotSchema = z.object({
  sessionId: canonicalReferenceId(128),
  draftRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  intent: z.enum(["open", "reply"]).optional(),
  seed: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("scratch") }).strict(),
    z.object({ kind: z.literal("recipe"), recipeId: canonicalReferenceId(128), version: canonicalReferenceId(64) }).strict(),
  ]),
  choices: z.object({
    skills: z.array(canonicalReferenceId(160)).max(256),
    services: z.array(z.string().regex(/^[a-z][a-z0-9_]{0,79}$/)).max(128),
  }).strict().refine(value => new Set(value.skills).size === value.skills.length
    && new Set(value.services).size === value.services.length, { message: "Draft choices must be unique" }).optional(),
  draft: BotCreationDraftSchema,
}).strict().refine(value => canonicalEncodedByteLength(value) <= 64 * 1024, { message: "Creation snapshot exceeds byte limit" });

export const BotDraftProposalSchema = z.object({
  proposalId: canonicalReferenceId(128),
  sessionId: BotCreationSnapshotSchema.shape.sessionId,
  baseDraftRevision: BotCreationSnapshotSchema.shape.draftRevision,
  patch: BotCreationDraftPatchSchema,
}).strict();
export const BotConnectionRequestedSchema = BotDraftProposalSchema.omit({ patch: true }).extend(BotConnectionRequestInputSchema.shape);

function setupQuestionFields(questionLimit: number, replyLimit: number) {
  return {
    question: canonicalBoundedText(questionLimit, questionLimit * 4),
    suggestedReplies: z.array(canonicalBoundedText(replyLimit, replyLimit * 4)).min(2).max(3)
      .refine(replies => new Set(replies.map(reply => reply.trim().toLowerCase())).size === replies.length, {
        message: "Preferred replies must be distinct",
      }),
  };
}
const compactQuestion = setupQuestionFields(140, 48);
export const BotSetupQuestionInputSchema = z.object(compactQuestion).strict()
  .refine(({ question, suggestedReplies }) => [question, ...suggestedReplies].every(text => !/[\r\n\u2028\u2029]/.test(text)),
    { message: "Use a single line for the question and each reply" });
// Existing setup activities can contain longer questions; preserve them on replay.
export const BotSetupQuestionSchema = BotDraftProposalSchema.omit({ patch: true }).extend(setupQuestionFields(800, 100)).strict();
export type BotSetupQuestion = z.infer<typeof BotSetupQuestionSchema>;
export type BotCreationDraft = z.infer<typeof BotCreationDraftSchema>;
export type BotCreationDraftPatch = z.infer<typeof BotCreationDraftPatchSchema>;
export type BotCreationSnapshot = z.infer<typeof BotCreationSnapshotSchema>;
export type BotDraftProposal = z.infer<typeof BotDraftProposalSchema>;

/** Account labels are owner choices. Catalog IDs express intent and cannot create a connection. */
export function botDraftPatchMatchesChoices(snapshot: BotCreationSnapshot, patch: BotCreationDraftPatch): boolean {
  const recipe = patch.recipe;
  if (!recipe) return true;
  const before = snapshot.draft.recipe;
  const skills = [...(snapshot.choices?.skills ?? []), ...(before?.skills ?? [])];
  return recipe.skills.every(skill => skills.includes(skill)) && recipe.integrations.every(source =>
    before?.integrations.some(existing => existing.service === source.service && existing.accountLabel === source.accountLabel)
    || (!source.accountLabel && snapshot.choices?.services.includes(source.service)));
}
