import { create } from "zustand";
import { useEffect, useEffectEvent, useRef } from "react";
import type { CanonicalChatClient } from "../../lib/canonical-chat-client";
import { invoke } from "../../lib/operator";
import { useChatAgentsNavigation, type StartAgentChat } from "@matrix-os/ui";
import type {
  NativeAppChatNavigationResult,
  NativeAppOpenChatEvent,
} from "../../../../shared/native-app-chat";

type State = {
  pending: NativeAppOpenChatEvent | null;
  canceledRequestId: string | null;
  queue(request: NativeAppOpenChatEvent): void;
  cancel(requestId: string): void;
  consumeCancellation(requestId: string): void;
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
  canceledRequestId: null,
  queue(request) {
    const previous = get().pending;
    if (previous && previous.requestId !== request.requestId) {
      void acknowledgeNativeAppChatNavigation(previous.requestId, { ok: false, error: "navigation_unavailable" })
        .catch(reportAcknowledgementFailure);
    }
    set({ pending: request });
  },
  cancel(requestId) {
    if (get().pending?.requestId === requestId) set({ pending: null, canceledRequestId: requestId });
  },
  consumeCancellation(requestId) {
    if (get().canceledRequestId === requestId) set({ canceledRequestId: null });
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
  const canceledRequestId = useNativeAppChatNavigation((state) => state.canceledRequestId);
  const cancel = useNativeAppChatNavigation((state) => state.cancel);
  const consumeCancellation = useNativeAppChatNavigation((state) => state.consumeCancellation);
  const complete = useNativeAppChatNavigation((state) => state.complete);
  const navigation = useChatAgentsNavigation();
  const handled = useRef<string | null>(null);
  const startChat = useEffectEvent(onStartChat);

  useEffect(() => {
    if (!canceledRequestId || !navigation) return;
    navigation.cancelRequest(canceledRequestId);
    if (handled.current === canceledRequestId) handled.current = null;
    consumeCancellation(canceledRequestId);
  }, [canceledRequestId, consumeCancellation, navigation]);

  useEffect(() => {
    if (canceledRequestId) return;
    if (!pending) return;
    if (pending.runtimeSlot !== runtimeSlot || pending.authGeneration !== authGeneration) {
      cancel(pending.requestId);
      return;
    }
    if (!active || !client?.agents || !navigation || handled.current === pending.requestId) return;
    const requestId = pending.requestId;
    if (navigation.getOpened()) navigation.close();
    let current = true;
    queueMicrotask(() => {
      if (!current) return;
      const queued = useNativeAppChatNavigation.getState().pending;
      if (queued?.requestId !== requestId || queued.runtimeSlot !== runtimeSlot
        || queued.authGeneration !== authGeneration || navigation.getOpened()) return;
      handled.current = requestId;
      navigation.open({
        client: client.agents!,
        requestId,
        view: "recipes",
        onStartChat: startChat,
        requestedRecipeId: queued.recipeId,
        onRequestedRecipeResult: (result) => {
          void complete(requestId, result).catch(reportAcknowledgementFailure);
        },
      });
      if (!queued.recipeId) void complete(requestId, { ok: true }).catch(reportAcknowledgementFailure);
    });
    return () => { current = false; };
  }, [active, authGeneration, cancel, canceledRequestId, client, complete, navigation, pending, runtimeSlot]);

  return null;
}
