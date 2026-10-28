import { create } from "zustand";
import { useEffect, useRef } from "react";
import type { CanonicalChatClient } from "../../lib/canonical-chat-client";
import { invoke } from "../../lib/operator";
import { useChatAgentsNavigation, type StartAgentChat } from "@matrix-os/ui";
import type {
  NativeAppChatNavigationResult,
  NativeAppOpenChatEvent,
} from "../../../../shared/native-app-chat";

type State = {
  pending: NativeAppOpenChatEvent | null;
  queue(request: NativeAppOpenChatEvent): void;
  cancel(requestId: string): void;
  complete(requestId: string, result: NativeAppChatNavigationResult): Promise<void>;
};

function reportAcknowledgementFailure(error: unknown): void {
  console.warn("[native-app-chat] acknowledgement failed:", error instanceof Error ? error.name : "UnknownError");
}

export async function acknowledgeNativeAppChatNavigation(requestId: string, result: NativeAppChatNavigationResult): Promise<void> {
  await invoke("app:open-chat-complete", { requestId, ...result });
}

export const useNativeAppChatNavigation = create<State>()((set, get) => ({
  pending: null,
  queue(request) {
    const previous = get().pending;
    if (previous && previous.requestId !== request.requestId) {
      void acknowledgeNativeAppChatNavigation(previous.requestId, { ok: false, error: "navigation_unavailable" })
        .catch(reportAcknowledgementFailure);
    }
    set({ pending: request });
  },
  cancel(requestId) {
    if (get().pending?.requestId === requestId) set({ pending: null });
  },
  async complete(requestId, result) {
    if (get().pending?.requestId !== requestId) return;
    set({ pending: null });
    await acknowledgeNativeAppChatNavigation(requestId, result);
  },
}));

/** Consumes one authenticated native request only after the Chat owner/client is ready. */
export function NativeAppChatNavigationHost({
  active,
  client,
  onStartChat,
  runtimeSlot,
  authGeneration,
}: {
  active: boolean;
  client: CanonicalChatClient | null;
  onStartChat: StartAgentChat;
  runtimeSlot: string;
  authGeneration: number;
}) {
  const pending = useNativeAppChatNavigation((state) => state.pending);
  const cancel = useNativeAppChatNavigation((state) => state.cancel);
  const complete = useNativeAppChatNavigation((state) => state.complete);
  const navigation = useChatAgentsNavigation();
  const handled = useRef<string | null>(null);

  useEffect(() => {
    if (!pending) return;
    if (pending.runtimeSlot !== runtimeSlot || pending.authGeneration !== authGeneration) {
      cancel(pending.requestId);
      return;
    }
    if (!active || !client?.agents || !navigation || handled.current === pending.requestId) return;
    handled.current = pending.requestId;
    const requestId = pending.requestId;
    navigation.open({
      client: client.agents,
      view: "recipes",
      onStartChat,
      requestedRecipeId: pending.recipeId,
      onRequestedRecipeResult: (result) => {
        void complete(requestId, result).catch(reportAcknowledgementFailure);
      },
    });
    if (!pending.recipeId) void complete(requestId, { ok: true }).catch(reportAcknowledgementFailure);
  }, [active, authGeneration, cancel, client, complete, navigation, onStartChat, pending, runtimeSlot]);

  return null;
}
