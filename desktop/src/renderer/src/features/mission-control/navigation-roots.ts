import { useHermesChat } from "../../stores/hermes-chat";
import { useTabs, type WorkRoute } from "../../stores/tabs";
import { useThreads } from "../../stores/threads";

function openWorkRoute(workRoute: WorkRoute): void {
  useTabs.getState().openTab({
    kind: "work",
    title: "Chat",
    workRoute,
    chatView: workRoute === "chat" ? "index" : undefined,
    closable: false,
  });
}

export function openChatIndex(): void {
  useThreads.getState().setActiveThread(null);
  useHermesChat.getState().showIndex();
  openWorkRoute("chat");
}

export function openTerminalIndex(): void {
  const tabs = useTabs.getState();
  tabs.openTab({ kind: "terminals", title: "Terminal", closable: false });
  tabs.requestTerminalOverview();
}

export function openProjectsIndex(): void {
  useTabs.getState().openTabAtHistoryRoot({
    kind: "work",
    title: "Chat",
    workRoute: "projects",
    closable: false,
  }, ["project", "task"]);
}

export function returnToProjectsIndex(): void {
  openProjectsIndex();
}
