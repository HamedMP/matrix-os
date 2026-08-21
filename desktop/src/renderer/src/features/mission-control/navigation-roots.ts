import { useHermesChat } from "../../stores/hermes-chat";
import { useTabs } from "../../stores/tabs";
import { useThreads } from "../../stores/threads";

export function openChatIndex(): void {
  useThreads.getState().setActiveThread(null);
  useHermesChat.getState().showIndex();
  useTabs.getState().openTab({ kind: "chat", title: "Hermes", closable: false });
}

export function openTerminalIndex(): void {
  const tabs = useTabs.getState();
  tabs.requestTerminalIndex();
  tabs.openTab({ kind: "terminals", title: "Terminal", closable: false });
}

export function openProjectsIndex(): void {
  useTabs.getState().openTabAtHistoryRoot({
    kind: "projects",
    title: "Projects",
    closable: false,
  }, ["project", "task"]);
}

export function returnToProjectsIndex(): void {
  openProjectsIndex();
}
