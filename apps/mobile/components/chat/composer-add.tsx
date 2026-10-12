import type { CanonicalChatModelSelection, CanonicalProviderCatalog } from "@matrix-os/contracts";

import { supportedAttachmentKinds, type ComposerAttachment } from "@/lib/chat-attachments";
import { chatSlashEntries } from "@/lib/chat-slash-entries";

import type { ComposerProps } from "./Composer";
import { ComposerAddControl } from "./ComposerAddControl";

export interface ComposerAddOptions {
  catalog: CanonicalProviderCatalog | null;
  /** The model the message goes to, which decides what can be added. */
  selection: CanonicalChatModelSelection | null;
  /** The photos and files waiting to go with the message. */
  attachments: readonly ComposerAttachment[];
  onAdd: (attachments: readonly ComposerAttachment[]) => void;
  onRemove: (id: string) => void;
  /** Puts a chosen skill or command, such as "/review", in the message. */
  onInvoke: (invocation: string) => void;
  /** False while there is nobody to send as. */
  enabled: boolean;
}

/**
 * What a screen hands its composer so that things can be added to a message:
 * the waiting attachments and the "+" that adds more. Every screen with a
 * composer builds these the same way, from the model its message goes to.
 */
export function composerAddProps({
  catalog,
  selection,
  attachments,
  onAdd,
  onRemove,
  onInvoke,
  enabled,
}: ComposerAddOptions): Pick<ComposerProps, "attachments" | "onRemoveAttachment" | "addControl"> {
  return {
    attachments,
    onRemoveAttachment: onRemove,
    addControl: (
      <ComposerAddControl
        kinds={supportedAttachmentKinds(catalog, selection)}
        attached={attachments.length}
        skills={chatSlashEntries(catalog, selection)}
        disabled={!enabled}
        onAdd={onAdd}
        onInvoke={onInvoke}
      />
    ),
  };
}
