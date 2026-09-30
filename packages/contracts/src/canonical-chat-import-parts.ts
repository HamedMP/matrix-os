import { z } from "zod/v4";
import { canonicalSafeLabel, canonicalReferenceId } from "#canonical-chat-primitives";
/** Historical source metadata is read-only; live user input cannot submit these parts. */
export const ImportedChatProvenancePartSchema = z.object({
  type: z.literal("import_provenance"), harness: z.enum(["codex", "claude"]), sourceId: z.uuid(),
  sourceKey: z.string().regex(/^[a-f0-9]{64}$/), phase: z.enum(["unknown", "human", "commentary", "final", "tool", "notice", "agent_task"]),
  origin: z.enum(["human", "assistant", "agent_task", "tool", "system"]),
  offset: z.number().int().min(0).max(20 * 1024 ** 3), end: z.number().int().min(1).max(20 * 1024 ** 3),
}).strict().refine(value => value.end > value.offset, "Invalid source boundary");
export const ImportedChatReferencePartSchema = z.object({
  type: z.literal("import_reference"), assetId: z.uuid(), kind: z.enum(["text", "tool_input", "tool_output", "image", "file"]),
  label: canonicalSafeLabel(240, 960), mimeType: z.string().min(1).max(120).regex(/^[A-Za-z0-9][A-Za-z0-9.+/-]+$/),
  sizeBytes: z.number().int().min(0).max(64 * 1024 * 1024),
}).strict();

export const ImportedChatAssetRefSchema = z.object({ chatId: canonicalReferenceId(160), assetId: z.uuid(), label: canonicalSafeLabel(240, 960) }).strict();
export type ImportedChatAssetRef = z.infer<typeof ImportedChatAssetRefSchema>;
export function importedChatAssetContentPath(input: ImportedChatAssetRef): string {
  const ref = ImportedChatAssetRefSchema.parse(input);
  return `/api/chats/${encodeURIComponent(ref.chatId)}/imports/assets/${ref.assetId}/content`;
}
