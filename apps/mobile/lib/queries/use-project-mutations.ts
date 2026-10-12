import { useMutation, useQueryClient } from "@tanstack/react-query";

import { useActiveGateway, type GatewaySession } from "@/lib/queries/use-active-gateway";
import {
  archiveProject,
  createProject,
  mobileQueryKeys,
  ProjectRequestError,
  renameProject,
  type CreateProjectInput,
  type ProjectSummary,
} from "@/lib/requests";

// What `ProjectSummaryListSchema` accepts when the list is read back from disk.
const PROJECT_LIST_LIMIT = 200;

/**
 * What the three project mutations share. Each one changes the cached list of
 * active projects only after the server has answered, with what it answered.
 */
function useProjectListWrites() {
  const queryClient = useQueryClient();
  const gateway = useActiveGateway();
  const projectsKey = mobileQueryKeys.projects(gateway.userId, gateway.computerKey);

  return {
    requireSession: async (): Promise<GatewaySession> => {
      const session = await gateway.session();
      if (!session) throw new ProjectRequestError("unavailable");
      return session;
    },
    /** Applies a confirmed change to the list, if the list has been loaded. */
    write: (change: (projects: ProjectSummary[]) => ProjectSummary[]) => {
      queryClient.setQueryData<ProjectSummary[]>(
        projectsKey,
        (projects) => projects && change(projects).slice(0, PROJECT_LIST_LIMIT),
      );
    },
    confirmed: {
      // A list read still in flight was sent before this request, so its
      // answer would put the old list back over the confirmed change.
      onMutate: () => queryClient.cancelQueries({ queryKey: projectsKey }),
      // Read again either way: a refusal means the list on screen was out of
      // date. Not awaited, so the button is released as soon as the request is.
      onSettled: () => {
        void queryClient.invalidateQueries({ queryKey: projectsKey });
      },
    },
  };
}

// The server lists projects by most recent change, so a project that was just
// created or renamed is the first one.
function movedToTop(projects: ProjectSummary[], project: ProjectSummary): ProjectSummary[] {
  return [project, ...projects.filter((candidate) => candidate.id !== project.id)];
}

/** Creates an empty project. Rejects with a `ProjectRequestError`; `name_taken` is the reason to expect. */
export function useCreateProject() {
  const { requireSession, write, confirmed } = useProjectListWrites();
  return useMutation({
    mutationFn: async (input: CreateProjectInput) => {
      const { token, gatewayUrl } = await requireSession();
      return createProject(token, gatewayUrl, input);
    },
    ...confirmed,
    onSuccess: (project: ProjectSummary) => write((projects) => movedToTop(projects, project)),
  });
}

/** Renames a project; its slug does not change. Rejects with a `ProjectRequestError`. */
export function useRenameProject() {
  const { requireSession, write, confirmed } = useProjectListWrites();
  return useMutation({
    mutationFn: async ({ slug, name }: { slug: string; name: string }) => {
      const { token, gatewayUrl } = await requireSession();
      return renameProject(token, gatewayUrl, slug, name);
    },
    ...confirmed,
    onSuccess: (project: ProjectSummary) => write((projects) => movedToTop(projects, project)),
  });
}

/**
 * Archives the project with this slug. While work is running in it the server
 * refuses, and this rejects with a `ProjectRequestError` whose reason is
 * `project_active`; the project then stays in the list.
 */
export function useArchiveProject() {
  const { requireSession, write, confirmed } = useProjectListWrites();
  return useMutation({
    mutationFn: async (slug: string) => {
      const { token, gatewayUrl } = await requireSession();
      return archiveProject(token, gatewayUrl, slug);
    },
    ...confirmed,
    onSuccess: (project: ProjectSummary) => write((projects) => projects.filter((candidate) => candidate.id !== project.id)),
  });
}
