import type { Project } from "../../stores/board";
import { useProjectView } from "../../stores/project-view";
import { useTabs } from "../../stores/tabs";

export function openWorkProject(project: Project, chatId?: string, chatTitle?: string) {
  useProjectView.getState().setView(project.slug, "chats");
  useTabs.getState().openTab({
    kind: "work",
    title: "Chat",
    workRoute: "project",
    projectSlug: project.slug,
    ...(chatId ? { chatId } : {}),
    ...(chatTitle ? { chatTitle } : {}),
    chatView: chatId ? "conversation" : "draft",
    closable: false,
  });
}
