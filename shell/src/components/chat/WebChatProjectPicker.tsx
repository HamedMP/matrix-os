"use client";
import type { KernelConversationContextProjection } from "@matrix-os/contracts";
import { ChatProjectContextPicker, type ChatProjectListStatus, type ChatProjectOption } from "@matrix-os/ui";
import { SHELL_Z_INDEX } from "@/lib/shell-layering";
import type { WebProject, WebProjectsState } from "./web-projects";

function repositoryLabel(project: WebProject): string | null {
  return project.github ? `${project.github.owner}/${project.github.repo}` : null;
}

/** The Chat's project as the shared picker shows it; one missing from a loaded list is unavailable. */
function projectContext(projectId: string | undefined, projects: WebProjectsState): KernelConversationContextProjection | null {
  if (!projectId) return null;
  const project = projects.projects.find((candidate) => candidate.id === projectId || candidate.slug === projectId);
  const repository = project ? repositoryLabel(project) : null;
  return {
    projectId,
    projectName: project?.name ?? projectId,
    projectKind: project?.kind ?? "scratch",
    ...(repository ? { repositoryLabel: repository } : {}),
    status: project || projects.loading ? "ready" : "unavailable",
  };
}

function listStatus(connected: boolean, projects: WebProjectsState): ChatProjectListStatus {
  if (!connected) return "disconnected";
  if (projects.error) return "error";
  return projects.loading ? "loading" : "ready";
}

function projectOptions(projects: WebProjectsState): ChatProjectOption[] {
  return projects.projects.map((project) => ({
    id: project.id, slug: project.slug, name: project.name, kind: project.kind, repository: repositoryLabel(project),
  }));
}

/** Electron Desktop's composer folder button: puts a new Chat in a project or moves an existing one. */
export function WebChatProjectPicker({ projectId, projects, connected, disabled, onSelect }: {
  projectId?: string;
  projects: WebProjectsState;
  connected: boolean;
  disabled: boolean;
  onSelect: (projectId: string | null) => void;
}) {
  const context = projectContext(projectId, projects);
  return (
    <ChatProjectContextPicker
      context={context}
      compact={!context}
      triggerLabel={context ? undefined : "Choose project for chat"}
      disabled={disabled}
      menuZIndex={SHELL_Z_INDEX.popover}
      projects={projectOptions(projects)}
      listStatus={listStatus(connected, projects)}
      onRetry={projects.retry}
      onSelect={(slug) => onSelect(projects.projects.find((candidate) => candidate.slug === slug)?.id ?? slug)}
      onRemove={() => onSelect(null)}
    />
  );
}
