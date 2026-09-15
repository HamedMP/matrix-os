import type { ChatAgentDraftRequest } from "@matrix-os/ui";
import { serializeComposerReferenceToken, type ComposerReferenceToken } from "./composer-reference-tokens";

/** The editor restores inline references from their serialized positions in text. */
export function chatAgentComposerDraft(request: ChatAgentDraftRequest) {
  const referenceTokens: ComposerReferenceToken[] = (request.resources ?? []).map((resource) => ({ type: "resource", resource }));
  const prefix = referenceTokens.map(serializeComposerReferenceToken).join(" ");
  return {
    text: prefix ? `${prefix} ${request.text}` : request.text,
    referenceTokens,
  };
}
