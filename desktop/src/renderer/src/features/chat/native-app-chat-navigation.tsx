import { create } from "zustand";
import { useEffect, useEffectEvent, useRef } from "react";
import type { CanonicalChatClient } from "../../lib/canonical-chat-client";
import { invoke } from "../../lib/operator";
import { useChatAgentsNavigation, type StartAgentChat } from "@matrix-os/ui";
import type {
  NativeAppChatNavigationResult,
  NativeAppOpenChatEvent,
} from "../../../../shared/native-app-chat";

type TargetedNativeAppOpenChatEvent = NativeAppOpenChatEvent & { targetTabId: string };

type State = {
  pending: TargetedNativeAppOpenChatEvent | null;
  canceledRequest: { requestId: string; targetTabId: string } | null;
  queue(request: NativeAppOpenChatEvent, targetTabId: string): void;
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
  canceledRequest: null,
  queue(request, targetTabId) {
    const previous = get().pending;
    if (previous && previous.requestId !== request.requestId) {
      void acknowledgeNativeAppChatNavigation(previous.requestId, { ok: false, error: "navigation_unavailable" })
        .catch(reportAcknowledgementFailure);
    }
    set({ pending: { ...request, targetTabId }, canceledRequest: null });
  },
  cancel(requestId) {
    const pending = get().pending;
    if (pending?.requestId === requestId) {
      set({ pending: null, canceledRequest: { requestId, targetTabId: pending.targetTabId } });
    }
  },
  consumeCancellation(requestId) {
    if (get().canceledRequest?.requestId === requestId) set({ canceledRequest: null });
  },
  async complete(requestId, result) {
    if (get().pending?.requestId !== requestId) return;
    set({ pending: null });
    await acknowledgeNativeAppChatNavigation(requestId, result);
  },
}));

/** Consumes one authenticated native request only in its selected, ready Chat surface. */
export function NativeAppChatNavigationHost({
  active,
  tabId,
  client,
  onStartChat,
  runtimeSlot,
  authGeneration,
}: {
  active: boolean;
  tabId?: string;
  client: CanonicalChatClient | null;
  onStartChat: StartAgentChat;
  runtimeSlot: string;
  authGeneration: number;
}) {
  const pending = useNativeAppChatNavigation((state) => state.pending);
  const canceledRequest = useNativeAppChatNavigation((state) => state.canceledRequest);
  const cancel = useNativeAppChatNavigation((state) => state.cancel);
  const consumeCancellation = useNativeAppChatNavigation((state) => state.consumeCancellation);
  const complete = useNativeAppChatNavigation((state) => state.complete);
  const navigation = useChatAgentsNavigation();
  const handled = useRef<string | null>(null);
  const startChat = useEffectEvent(onStartChat);

  useEffect(() => {
    if (!canceledRequest || canceledRequest.targetTabId !== tabId || !navigation) return;
    navigation.cancelRequest(canceledRequest.requestId);
    if (handled.current === canceledRequest.requestId) handled.current = null;
    consumeCancellation(canceledRequest.requestId);
  }, [canceledRequest, consumeCancellation, navigation, tabId]);

  useEffect(() => {
    if (canceledRequest?.targetTabId === tabId) return;
    if (!pending) return;
    if (pending.targetTabId !== tabId) return;
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
      if (queued?.requestId !== requestId || queued.targetTabId !== tabId || queued.runtimeSlot !== runtimeSlot
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
  }, [active, authGeneration, cancel, canceledRequest, client, complete, navigation, pending, runtimeSlot, tabId]);

  return null;
}
