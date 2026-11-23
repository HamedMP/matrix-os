import { z } from "zod/v4";
import { canonicalEncodedByteLength, canonicalReferenceId } from "#canonical-chat-primitives";
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

export const BotCreationSnapshotSchema = z.object({
  sessionId: canonicalReferenceId(128),
  draftRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  seed: z.object({ kind: z.literal("scratch") }).strict(),
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
