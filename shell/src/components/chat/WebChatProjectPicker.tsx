"use client";
import type { KernelConversationContextProjection } from "@matrix-os/contracts";
import { ChatProjectContextPicker } from "@matrix-os/ui";
import { SHELL_Z_INDEX } from "@/lib/shell-layering";
import type { WebProjectsState } from "./web-projects";

/** Electron Desktop's composer folder button: puts a new Chat in a project or moves an existing one. */
export function WebChatProjectPicker({ projectId, projects, connected, disabled, onSelect }: {
  projectId?: string;
  projects: WebProjectsState;
  connected: boolean;
  disabled: boolean;
  onSelect: (projectId: string | null) => void;
}) {
  const project = projectId ? projects.projects.find((candidate) => candidate.id === projectId || candidate.slug === projectId) : undefined;
  const context: KernelConversationContextProjection | null = projectId ? {
    projectId,
    projectName: project?.name ?? projectId,
    projectKind: project?.kind ?? "scratch",
    ...(project?.github ? { repositoryLabel: `${project.github.owner}/${project.github.repo}` } : {}),
    status: project || projects.loading ? "ready" : "unavailable",
  } : null;
  return (
    <ChatProjectContextPicker
      context={context}
      compact={!context}
      triggerLabel={context ? undefined : "Choose project for chat"}
      disabled={disabled}
      menuZIndex={SHELL_Z_INDEX.popover}
      projects={projects.projects.map((candidate) => ({
        id: candidate.id,
        slug: candidate.slug,
        name: candidate.name,
        kind: candidate.kind,
        repository: candidate.github ? `${candidate.github.owner}/${candidate.github.repo}` : null,
      }))}
      listStatus={!connected ? "disconnected" : projects.error ? "error" : projects.loading ? "loading" : "ready"}
      onRetry={projects.retry}
      onSelect={(slug) => onSelect(projects.projects.find((candidate) => candidate.slug === slug)?.id ?? slug)}
      onRemove={() => onSelect(null)}
    />
  );
}
