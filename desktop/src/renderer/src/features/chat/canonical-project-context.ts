import type { KernelConversationContextProjection } from "@matrix-os/contracts";
import type { Project } from "../../stores/board";

export function projectContext(
  projectId: string | undefined,
  projects: readonly Project[],
  fallbackLabel?: string,
): KernelConversationContextProjection | null {
  if (!projectId) return null;
  const project = projects.find((candidate) => (
    candidate.id === projectId || candidate.slug === projectId
  ));
  return {
    projectId,
    projectName: project?.name ?? fallbackLabel ?? projectId,
    projectKind: project?.kind ?? "folder",
    ...(project?.repository ? { repositoryLabel: project.repository } : {}),
    status: project || fallbackLabel ? "ready" : "unavailable",
  };
}

