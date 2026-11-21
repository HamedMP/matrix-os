"use client";

// Dialogs shared by every project row in one Projects rail placement: add,
// delete, and whole-project sharing (including "share after creating").
import { ProjectSharingHost, type ProjectShareAvailability } from "@matrix-os/ui";
import { useState, type ReactNode } from "react";
import { useCollaborationOrganization } from "@/lib/collaboration-organization-state";
import { SHELL_Z_INDEX } from "@/lib/shell-layering";
import { WebAddProjectDialog, WebProjectDeleteDialog } from "./WebProjectDialogs";
import { useWebProjectSharingContext } from "./web-project-sharing";
import type { WebProject, WebProjectsState } from "./web-projects";

const SHARING_LAYERS = { popover: SHELL_Z_INDEX.popover };

export interface WebProjectManagement {
  sharing: ReturnType<typeof useWebProjectSharingContext>;
  openAdd(): void;
  prepareSharing(): void;
  openDelete(project: WebProject): void;
  openShare(project: WebProject): void;
  dialogs: ReactNode;
}

export function useWebProjectManagement({ state, gatewayUrl, enabled, onProjectAdded, onProjectDeleted }: {
  state: WebProjectsState;
  gatewayUrl: string;
  enabled: boolean;
  onProjectAdded(project: WebProject): void;
  onProjectDeleted(project: WebProject): void;
}): WebProjectManagement {
  const { status } = useCollaborationOrganization();
  // Resolved on first use (a row menu or the add dialog), not on every rail render.
  const [sharingWanted, setSharingWanted] = useState(false);
  const sharing = useWebProjectSharingContext(gatewayUrl, enabled && sharingWanted);
  const [addOpen, setAddOpen] = useState(false);
  // Targets carry the rail identity so a former computer's project never stays targeted.
  const [deleteTarget, setDeleteTarget] = useState<{ identity: string; project: WebProject } | null>(null);
  const [shareTarget, setShareTarget] = useState<{ identity: string; project: WebProject; requestId: string } | null>(null);
  const deleting = deleteTarget?.identity === state.identity ? deleteTarget.project : null;
  const shared = shareTarget?.identity === state.identity && sharing ? shareTarget : null;
  const shareAvailability: ProjectShareAvailability = status === "member" && !sharing ? "unavailable" : status;
  const openShare = (project: WebProject) => setShareTarget({ identity: state.identity, project, requestId: crypto.randomUUID() });

  const dialogs = enabled ? <>
    <WebAddProjectDialog open={addOpen} gatewayUrl={gatewayUrl} scope={state.identity} projects={state.projects}
      shareAvailability={shareAvailability} onClose={() => setAddOpen(false)} onProjectAdded={onProjectAdded} onShareCreated={openShare} />
    {/* The list refreshes only after the gateway confirms; a focused project then drops out of focus with it. */}
    <WebProjectDeleteDialog project={deleting} gatewayUrl={gatewayUrl} onClose={() => setDeleteTarget(null)} onDeleted={onProjectDeleted} />
    {shared && sharing ? <ProjectSharingHost key={shared.requestId} sharing={sharing} projectId={shared.project.id} projectName={shared.project.name}
      layers={SHARING_LAYERS} startOnMount onClose={() => setShareTarget(null)} /> : null}
  </> : null;

  return {
    sharing,
    openAdd: () => { setSharingWanted(true); setAddOpen(true); },
    prepareSharing: () => setSharingWanted(true),
    openDelete: project => setDeleteTarget({ identity: state.identity, project }),
    openShare,
    dialogs,
  };
}
