import type { CanonicalChatMessagePart } from "@matrix-os/contracts";
import type { CanonicalChatClient } from "../../lib/canonical-chat-client";
import {
  canonicalChatInputParts,
  canonicalChatRequestId,
  canonicalChatTitle,
} from "../chat/canonical-chat-submission";
import { canonicalResourceReferenceForPath } from "../chat/chat-resource-search";
import type { CanonicalComposerSelection } from "../chat/canonical-composer-state";
import type { SharedChatComposerSubmission } from "../chat/SharedChatComposer";

export async function startCanonicalProjectChat({
  client,
  projectId,
  submission,
  attachmentPaths,
  selection,
}: {
  client: CanonicalChatClient;
  projectId: string;
  submission: SharedChatComposerSubmission;
  attachmentPaths: string[];
  selection: CanonicalComposerSelection;
}): Promise<{ chatId: string; title: string } | null> {
  const uploadedParts: CanonicalChatMessagePart[] = attachmentPaths.map((path) => ({
    type: "resource_reference",
    resource: canonicalResourceReferenceForPath("file", path),
  }));
  const parts = [...canonicalChatInputParts(submission), ...uploadedParts];
  if (parts.length === 0) return null;
  const title = canonicalChatTitle(submission);
  const modelSelection = {
    instanceId: selection.instanceId,
    model: selection.model,
    ...(selection.options.length > 0 ? { options: selection.options } : {}),
  };
  const created = await client.create({
    clientRequestId: canonicalChatRequestId(),
    title,
    projectId,
    currentSelection: modelSelection,
  });
  const admitted = await client.admitTurn(created.chat.id, {
    clientRequestId: canonicalChatRequestId(),
    baseRevision: created.chat.revision,
    parts,
    selection: modelSelection,
    interactionMode: selection.interactionMode,
    permissionMode: selection.permissionMode,
  });
  return { chatId: admitted.record.chat.id, title };
}
