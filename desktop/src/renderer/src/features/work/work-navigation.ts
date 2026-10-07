import type { Project } from "../../stores/board";
import { useCodingAgentWorkspace } from "../../stores/coding-agent-workspace";
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
    chatView: chatId ? "conversation" : "index",
    closable: false,
  });
}

// Project selection opens its overview; compose is a separate draft intent even
// when that same Project is already selected. The server Chat is created on send.
export function openWorkProjectDraft(project: Project) {
  useProjectView.getState().setView(project.slug, "chats");
  useCodingAgentWorkspace.getState().requestComposerFocus();
  useTabs.getState().openTab({
    kind: "work",
    title: "Chat",
    workRoute: "project",
    projectSlug: project.slug,
    chatView: "draft",
    closable: false,
  });
}
