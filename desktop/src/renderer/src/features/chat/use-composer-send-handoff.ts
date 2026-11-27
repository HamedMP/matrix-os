import { useState } from "react";
import { createComposerSendHandoff } from "@matrix-os/ui";

/**
 * Electron Desktop's side of the shared composer send handoff: the sent draft
 * leaves the composer when its pending message shows, and comes back if the
 * send is not admitted. Sent attachments stay in their controller (a retry
 * reuses their uploads) but out of sight until the send settles.
 */
export function useComposerSendHandoff<T extends { localId: string }>(items: readonly T[]) {
  const [sentIds, setSentIds] = useState<readonly string[]>([]);
  const sent = new Set(sentIds);
  const visibleAttachments = sent.size ? items.filter(item => !sent.has(item.localId)) : items;
  const begin = (send: {
    attachmentIds: readonly string[];
    /** Empties the composer; false when it no longer holds this send's draft. */
    clear(): boolean;
    restore(): void;
    /** The existing acknowledgement: clears a still-unchanged draft and removes the sent attachments. */
    settle(): void;
  }) => {
    // Only this send's hidden attachments, never a later send's.
    const reveal = () => setSentIds(current => current === send.attachmentIds ? [] : current);
    return createComposerSendHandoff({
      clear: () => {
        if (!send.clear()) return false;
        setSentIds(send.attachmentIds);
        return true;
      },
      restore: () => { reveal(); send.restore(); },
      settle: () => { send.settle(); reveal(); },
    });
  };
  return { visibleAttachments, begin };
}
