import { useProjectView } from "../stores/project-view";
import { useTabs } from "../stores/tabs";

/** Open a project through a project-level entry point, never a stale nested view. */
export function openProjectOverview(projectSlug: string, title: string): void {
  useProjectView.getState().setView(projectSlug, "overview");
  useTabs.getState().openTab({ kind: "project", projectSlug, title });
}
