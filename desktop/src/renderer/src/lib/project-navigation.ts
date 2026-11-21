import { useProjectView } from "../stores/project-view";
import { useTabs } from "../stores/tabs";
import { useProjectChatLauncher } from "./project-chat";

/**
 * Open a project through a project-level entry point on its remembered home
 * view (Overview or Board), never a stale nested view.
 */
export function openProjectHome(projectSlug: string, title: string): void {
  const projectView = useProjectView.getState();
  if (projectView.viewFor(projectSlug) !== "board") projectView.setView(projectSlug, "overview");
  useTabs.getState().openTab({ kind: "project", projectSlug, title });
}

/** Open a project on its task board. */
export function openProjectBoard(projectSlug: string, title: string): void {
  // Explicit Board navigation ends a pending new-chat request that would otherwise keep Overview showing.
  useProjectChatLauncher.getState().consumeComposer(projectSlug);
  useProjectView.getState().setView(projectSlug, "board");
  useTabs.getState().openTab({ kind: "project", projectSlug, title });
}
