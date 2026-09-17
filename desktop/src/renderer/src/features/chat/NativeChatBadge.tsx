import { useEffect } from "react";
import { chatMessageVersionUrl, chatReadStateVersionUrl } from "@matrix-os/contracts";
import { createCanonicalChatClient, createCanonicalChatEventSource } from "../../lib/canonical-chat-client";
import { wireCanonicalChatBadge } from "../../lib/canonical-chat-badge";
import { invoke } from "../../lib/operator";
import { useConnection } from "../../stores/connection";

/** One native badge owner, independent of open/minimized Chat windows. */
export function NativeChatBadge() {
  const api = useConnection((state) => state.api);
  const runtimeSlot = useConnection((state) => state.runtimeSlot);
  const authGeneration = useConnection((state) => state.authGeneration);
  const status = useConnection((state) => state.status);
  useEffect(() => {
    if (!api || status === "signed-out" || status === "loading" || !window.operator) return;
    const eventSource = createCanonicalChatEventSource({
      openStream({ cursor, signal }) {
        return api.openStream(chatReadStateVersionUrl(chatMessageVersionUrl("/api/chats/events")), {
          accept: "text/event-stream", signal, timeoutMs: 5 * 60 * 1000,
          headers: { "x-matrix-chat-protocol": "2", ...(cursor === undefined ? {} : { "last-event-id": String(cursor) }) },
        });
      },
    });
    const disposeBadge = wireCanonicalChatBadge({
      client: createCanonicalChatClient(api), eventSource,
      setBadge: async (count) => { await invoke("badge:set", { count }); },
    });
    void eventSource.start();
    return () => { disposeBadge(); eventSource.dispose(); };
  }, [api, runtimeSlot, authGeneration, status]);
  return null;
}
