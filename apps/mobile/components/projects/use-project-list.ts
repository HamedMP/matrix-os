import { useQueryClient } from "@tanstack/react-query";

import { useActiveGateway } from "@/lib/queries/use-active-gateway";
import { useProjects } from "@/lib/queries/use-projects";
import { mobileQueryKeys } from "@/lib/requests/query-keys";

/** The computer's active projects, and a way to read them again that works before the computer is known. */
export function useProjectList() {
  const projects = useProjects();
  const gateway = useActiveGateway();
  const queryClient = useQueryClient();

  const reload = async () => {
    try {
      // Without a computer there is nothing to read the projects from; once it
      // is known they are read by themselves.
      if (gateway.ready) await projects.refetch();
      else await queryClient.invalidateQueries({ queryKey: mobileQueryKeys.activeComputer(gateway.userId) });
    } catch (error: unknown) {
      console.warn("[mobile] projects reload failed", error instanceof Error ? error.name : "unknown");
    }
  };

  const state: "loading" | "error" | "ready" = projects.isPending
    ? "loading"
    : projects.isError && projects.projects.length === 0 ? "error" : "ready";

  return {
    projects: projects.projects,
    /** "error": the projects could not be read and there are none to show. */
    state,
    reload,
  };
}
