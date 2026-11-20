import { AddProjectForm, type AddProjectButtonProps, type AddProjectFolderPickerProps, type ProjectShareAvailability } from "@matrix-os/ui";
import { useCallback, useEffect, useState } from "react";
import { Button, Dialog } from "../../design/primitives";
import { toUserMessage } from "../../lib/errors";
import { useBoard } from "../../stores/board";
import { useConnection } from "../../stores/connection";
import ComputerFileBrowser from "../files/ComputerFileBrowser";
import { createDesktopAddProjectContext } from "./add-project-adapter";
import {
  DesktopProjectSharingHost,
  useDesktopProjectSharingContext,
} from "../project/DesktopProjectSharing";
import type { Project } from "../../stores/board";

function DesktopAddProjectButton({ variant, disabled, onClick, children }: AddProjectButtonProps) {
  return <Button variant={variant} disabled={disabled} onClick={onClick}>{children}</Button>;
}

function DesktopFolderPicker(props: AddProjectFolderPickerProps) {
  return <ComputerFileBrowser compact mode="folder-picker" {...props} />;
}

// Electron Desktop chrome and transport for the shared add-project form.
function CreateProjectForm({ onClose, shareAvailability, onCreatedProject, onProjectReady }: {
  onClose: () => void;
  shareAvailability: ProjectShareAvailability;
  onCreatedProject: (project: Project) => void;
  onProjectReady?: (project: Project) => Promise<void | (() => void)>;
}) {
  const api = useConnection((s) => s.api);
  const projects = useBoard((s) => s.projects);
  const runtimeSlot = useConnection((s) => s.runtimeSlot);
  const authGeneration = useConnection((s) => s.authGeneration);
  return <AddProjectForm
    scope={`${runtimeSlot}\u0000${authGeneration}`}
    projects={projects}
    Button={DesktopAddProjectButton}
    FolderPicker={DesktopFolderPicker}
    createContext={({ shareRequested, ...base }) => api ? createDesktopAddProjectContext({
      api,
      ...base,
      ...(shareRequested ? { onCreatedProject } : {}),
      onProjectReady,
    }) : null}
    toErrorMessage={toUserMessage}
    onClose={onClose}
    shareAvailability={shareAvailability}
    folderRequestPrefix="req_desktop_folder_"
  />;
}

export default function CreateProjectDialog({ open, onClose, onProjectReady }: { open: boolean; onClose: () => void; onProjectReady?: (project: Project) => Promise<void | (() => void)> }) {
  const organizationId = useConnection((state) => state.organizationId);
  const organizationStatus = useConnection((state) => state.organizationStatus);
  const [shareTarget, setShareTarget] = useState<{
    id: string;
    name: string;
    organizationId: string;
    requestId: string;
  } | null>(null);
  const sharing = useDesktopProjectSharingContext(
    organizationStatus === "member" && (open || shareTarget !== null),
  );
  const shareAvailability = organizationStatus === "member" && !sharing
    ? "unavailable"
    : organizationStatus;

  useEffect(() => {
    if (shareTarget && shareTarget.organizationId !== organizationId) setShareTarget(null);
  }, [organizationId, shareTarget]);

  const handleCreatedProject = useCallback((project: Project) => {
    if (!project.id || !organizationId) {
      console.warn("[project-collaboration] created project sharing context unavailable");
      return;
    }
    setShareTarget({
      id: project.id,
      name: project.name || project.slug,
      organizationId,
      requestId: crypto.randomUUID(),
    });
  }, [organizationId]);

  return <>
    <Dialog open={open} onClose={onClose} width={480} title="Create a project" placement="center">
      <CreateProjectForm
        onClose={onClose}
        shareAvailability={shareAvailability}
        onCreatedProject={handleCreatedProject}
        onProjectReady={onProjectReady}
      />
    </Dialog>
    {shareTarget && sharing?.organizationId === shareTarget.organizationId ? <DesktopProjectSharingHost
      key={shareTarget.requestId}
      sharing={sharing}
      projectId={shareTarget.id}
      projectName={shareTarget.name}
      startOnMount
      onClose={() => setShareTarget(null)}
    /> : null}
  </>;
}
