import { onEvent } from "./operator";
import { useConnection } from "../stores/connection";
import { useTabs } from "../stores/tabs";
import { useDesktopSurfaces } from "../stores/desktop-surfaces";
import { openChatIndex } from "../features/mission-control/navigation-roots";
import { acknowledgeNativeAppChatNavigation, useNativeAppChatNavigation } from "../features/chat/native-app-chat-navigation";

function reportChatNavigationFailure(error: unknown): void {
  console.warn("[native-app-chat] rejected request acknowledgement failed:", error instanceof Error ? error.name : "UnknownError");
}

/** One listener for every native OS view; ordinary app tabs own embed launching. */
export function wireNativeAppOpening(): () => void {
  const disposeApp = onEvent("app:open", (request) => {
    const current = useConnection.getState();
    if (current.status !== "signed-in" || request.runtimeSlot !== current.runtimeSlot
      || request.authGeneration !== current.authGeneration) return;
    const tabId = useTabs.getState().openTab({ kind: "app", slug: request.slug, title: request.name, appIdentity: request.appIdentity });
    // Opening an existing minimized/closed tab also restores its presentation.
    // New surfaces remain owned by the shell's normal tab reconciliation.
    useDesktopSurfaces.getState().activateSurface(tabId);
  });
  const disposeChat = onEvent("app:open-chat", (request) => {
    const current = useConnection.getState();
    if (current.status !== "signed-in" || request.runtimeSlot !== current.runtimeSlot
      || request.authGeneration !== current.authGeneration) {
      void acknowledgeNativeAppChatNavigation(request.requestId, {
        ok: false, error: "navigation_unavailable",
      }).catch(reportChatNavigationFailure);
      return;
    }
    const tabId = openChatIndex();
    useDesktopSurfaces.getState().activateSurface(tabId);
    useNativeAppChatNavigation.getState().queue(request, tabId);
  });
  const disposeChatCancellation = onEvent("app:open-chat-cancel", ({ requestId }) => {
    useNativeAppChatNavigation.getState().cancel(requestId);
  });
  const disposeConnection = useConnection.subscribe((current) => {
    const pending = useNativeAppChatNavigation.getState().pending;
    if (!pending) return;
    if (current.status !== "signed-in" || pending.runtimeSlot !== current.runtimeSlot
      || pending.authGeneration !== current.authGeneration) {
      useNativeAppChatNavigation.getState().cancel(pending.requestId);
    }
  });
  return () => { disposeApp(); disposeChat(); disposeChatCancellation(); disposeConnection(); };
}
