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
export const BotCreationDraftPatchSchema = BotCreationDraftSchema.partial()
  .refine(value => Object.keys(value).length > 0, { message: "Draft patch must change a field" })
  .refine(value => value.recipe?.jevInboxLabeling !== true, { message: "Model proposals cannot grant inbox labeling" });

export const BotCreationSnapshotSchema = z.object({
  sessionId: canonicalReferenceId(128),
  draftRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  seed: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("scratch") }).strict(),
    z.object({ kind: z.literal("template"), recipeId: canonicalReferenceId(128), recipeVersion: canonicalReferenceId(64) }).strict(),
  ]),
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
