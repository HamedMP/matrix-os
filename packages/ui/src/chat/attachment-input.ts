import { botImageTotalMaximumForSelection, botAttachmentInputError, type BotAttachmentMetadata, type CanonicalProviderInstanceDescriptor, type CanonicalProviderCatalog, type CanonicalChatModelSelection, BOT_FUNDED_IMAGE_TOTAL_MAX_BYTES } from "@matrix-os/contracts";
/** The same managed upload policy is used before upload in every composer and at admission. */
export function chatAttachmentSubmissionError(instance: CanonicalProviderInstanceDescriptor | null | undefined,
  modelId: string | undefined, files: readonly { type: string; size: number }[], options?: readonly { id: string; value: string | boolean }[]): string | null {
  if (!files.length) return null;
  if (!instance?.supports.attachments.some(kind => kind === "file" || kind === "image")) return "The selected provider does not support file attachments.";
  if (!["matrix_pi", "matrix_bot"].includes(instance.driverKind)) return null;
  const parts: BotAttachmentMetadata[] = files.map(file => ({ kind: file.type.startsWith("image/") ? "image" : "file", mimeType: file.type, sizeBytes: file.size }));
  return botAttachmentInputError(parts, instance.models.find(model => model.id === modelId)?.supportsVision === true, botImageTotalMaximumForSelection(instance.id, options));
}

/** Recipe presentation uses its actual saved coordinator, not the private adapter's picker identity. */
export function chatAttachmentComposerPolicy(catalog: CanonicalProviderCatalog | null | undefined,
  selection: Pick<CanonicalChatModelSelection, "instanceId" | "model" | "options"> | null | undefined, recipeAutomatic = false) {
  const instance = catalog?.instances.find(instance => instance.id === selection?.instanceId);
  const automatic = recipeAutomatic && selection?.instanceId === "matrix_bot_default" && selection.model === "auto";
  return {
    enabled: automatic || Boolean(instance?.supports.attachments.some(kind => kind === "image" || kind === "file")),
    error: (files: readonly { type: string; size: number }[]) => automatic
      ? botAttachmentInputError(files.map(file => ({ kind: file.type.startsWith("image/") ? "image" : "file", mimeType: file.type, sizeBytes: file.size })), true, BOT_FUNDED_IMAGE_TOTAL_MAX_BYTES)
      : chatAttachmentSubmissionError(instance, selection?.model, files, selection?.options),
  };
}
