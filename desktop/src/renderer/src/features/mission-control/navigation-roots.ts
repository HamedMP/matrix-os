import { useDesktopSurfaces } from "../../stores/desktop-surfaces";
import { useHermesChat } from "../../stores/hermes-chat";
import { useTabs, type WorkRoute } from "../../stores/tabs";
import { useThreads } from "../../stores/threads";

function openWorkRoute(workRoute: WorkRoute): string {
  return useTabs.getState().openTab({
    kind: "work",
    title: "Chat",
    workRoute,
    chatView: workRoute === "chat" ? "index" : undefined,
    closable: false,
  });
}

export function openChatIndex(): string {
  useThreads.getState().setActiveThread(null);
  useHermesChat.getState().showIndex();
  return openWorkRoute("chat");
}

export function openTerminalIndex(): void {
  const tabs = useTabs.getState();
  tabs.openTab({ kind: "terminals", title: "Terminal", closable: false });
  tabs.requestTerminalOverview();
}

/** Focus one terminal tab (`workspaceId:tabId`) in the Terminal app, reopening a closed surface. */
export function openTerminalSession(sessionName: string): void {
  const tabId = useTabs.getState().openTab({ kind: "terminals", title: "Terminal" });
  // Selecting the retained tab alone cannot revive a closed desktop surface.
  useDesktopSurfaces.getState().activateSurface(tabId);
  useTabs.getState().requestTerminalSession(sessionName);
}
