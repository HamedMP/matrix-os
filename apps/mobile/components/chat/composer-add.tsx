import type { CanonicalChatModelSelection, CanonicalProviderCatalog } from "@matrix-os/contracts";

import { unreadableNotice, type ChatAttachmentKind, type ComposerAttachment } from "@/lib/chat-attachments";
import { chatSlashEntries, draftWithInvocation } from "@/lib/chat-slash-entries";

import type { ComposerProps } from "./Composer";
import { ComposerAddControl } from "./ComposerAddControl";

export interface ComposerAddOptions {
  catalog: CanonicalProviderCatalog | null;
  /** The model the message goes to, whose skills and commands are offered. */
  selection: CanonicalChatModelSelection | null;
  /** The kinds of attachment that model reads: the same list the composer holds sends back by. */
  kinds: readonly ChatAttachmentKind[];
  /** The photos and files waiting to go with the message. */
  attachments: readonly ComposerAttachment[];
  /** How many more the message can take. */
  room: number;
  /** Those of the waiting attachments the model does not read. */
  unreadable: readonly ComposerAttachment[];
  /** Safe preflight copy, including a failed message held back under a changed selection. */
  attachmentNotice?: string | null;
  onAdd: (attachments: readonly ComposerAttachment[]) => void;
  onRemove: (id: string) => void;
  draft: string;
  /** Takes the draft with a chosen skill or command put first. */
  onChangeDraft: (text: string) => void;
  /** False while nothing can be added, as when there is nobody to send as. */
  enabled: boolean;
}

/**
 * What a screen hands its composer so that things can be added to a message:
 * the waiting attachments, what to say about those that cannot be sent, and
 * the "+" that adds more. Every screen with a composer builds these the same
 * way, from the model its message goes to.
 */
export function composerAddProps({
  catalog,
  selection,
  kinds,
  attachments,
  room,
  unreadable,
  attachmentNotice,
  onAdd,
  onRemove,
  draft,
  onChangeDraft,
  enabled,
}: ComposerAddOptions): Pick<ComposerProps, "attachments" | "onRemoveAttachment" | "attachmentNotice" | "addControl"> {
  const skills = chatSlashEntries(catalog, selection);
  return {
    attachments,
    onRemoveAttachment: onRemove,
    attachmentNotice: attachmentNotice ?? unreadableNotice(unreadable),
    addControl: (
      <ComposerAddControl
        kinds={kinds}
        room={room}
        skills={skills}
        disabled={!enabled}
        onAdd={onAdd}
        onInvoke={(invocation) => {
          onChangeDraft(draftWithInvocation(draft, invocation, skills.map((entry) => entry.invocation)));
        }}
      />
    ),
  };
}
