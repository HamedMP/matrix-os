import {
  botAttachmentInputError,
  botImageTotalMaximumForSelection,
  type CanonicalChatModelSelection,
  type CanonicalProviderCatalog,
} from "@matrix-os/contracts";

import type { ComposerAttachment } from "./chat-attachments";

/** Client hints only: the gateway still validates the files and admits the selected route. */
export function chatAttachmentSubmissionError(
  catalog: CanonicalProviderCatalog | null,
  selection: CanonicalChatModelSelection | null,
  attachments: readonly ComposerAttachment[],
  recipeAutomatic = false,
): string | null {
  if (attachments.length === 0) return null;
  // Recipes name their saved coordinator through the private auto route,
  // which has no catalog vision model. Match the existing Web recipe policy.
  const automatic = recipeAutomatic && selection?.instanceId === "matrix_bot_default" && selection.model === "auto";
  const instance = catalog?.instances.find((candidate) => candidate.id === selection?.instanceId);
  if (!selection || (!automatic && !instance?.supports.attachments.some((kind) => kind === "image" || kind === "file"))) {
    return "The selected provider does not support file attachments.";
  }
  if (!automatic && instance?.driverKind !== "matrix_pi" && instance?.driverKind !== "matrix_bot") return null;
  return botAttachmentInputError(
    attachments,
    automatic || instance?.models.find((model) => model.id === selection?.model)?.supportsVision === true,
    botImageTotalMaximumForSelection(selection.instanceId, automatic ? undefined : selection.options),
  );
}
