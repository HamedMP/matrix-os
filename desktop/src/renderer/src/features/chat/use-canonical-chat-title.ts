import { useCallback } from "react";
import type { CanonicalChatClient } from "../../lib/canonical-chat-client";
import type { CanonicalChatRecord } from "@matrix-os/contracts";

/** A fresh title-version guard is independent of changing run revisions. */
export function useCanonicalChatTitle(client: CanonicalChatClient,
  capture: () => () => boolean, publish: (record: CanonicalChatRecord) => void) {
  return useCallback(async (chatId: string, title: string): Promise<boolean> => {
    const current = capture();
    try {
      const detail = await client.getDetail(chatId);
      if (!current()) return false;
      const updated = await client.updateTitle(chatId, { title,
        expectedTitleVersion: detail.record.chat.titleVersion ?? 0 });
      if (!current()) return false;
      publish(updated);
      return true;
    } catch (error: unknown) {
      console.warn("[chat] title unavailable", error instanceof Error ? error.name : "UnknownError");
      return false;
    }
  }, [client, capture, publish]);
}
