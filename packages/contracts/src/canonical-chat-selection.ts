import { z } from "zod/v4";
import { ProviderModelReferenceSchema } from "#contract-primitives";
import { canonicalReferenceId } from "#canonical-chat-primitives";

export const CanonicalChatModelSelectionSchema = z.object({
  instanceId: canonicalReferenceId(128),
  model: ProviderModelReferenceSchema,
  options: z.array(z.object({
    id: canonicalReferenceId(80),
    value: z.union([canonicalReferenceId(160), z.boolean()]),
  }).strict()).max(32).optional(),
}).strict().superRefine((selection, ctx) => {
  const ids = selection.options?.map((option) => option.id) ?? [];
  if (new Set(ids).size !== ids.length) {
    ctx.addIssue({ code: "custom", path: ["options"], message: "Duplicate option selection" });
  }
});
