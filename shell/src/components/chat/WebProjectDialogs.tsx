"use client";

// Web Desktop and Web Canvas chrome for the shared add-project and
// delete-project flows. Behavior, copy, and validation come from @matrix-os/ui.
import {
  AddProjectForm, ProjectDeleteConfirmation,
  type AddProjectButtonProps, type AddProjectSubmitContext, type ProjectDeleteButtonProps,
} from "@matrix-os/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { SHELL_Z_INDEX } from "@/lib/shell-layering";
import { createWebProjectClient } from "./web-project-client";
import { WebFolderPickerGateway, WebProjectFolderPicker } from "./WebProjectFolderPicker";
import type { WebProject } from "./web-projects";

const UNEXPECTED_FAILURE = "Something went wrong. Please try again.";
const dialogLayer = { style: { zIndex: SHELL_Z_INDEX.appDialog }, overlayStyle: { zIndex: SHELL_Z_INDEX.appDialog } };

function AddProjectButton({ variant, disabled, onClick, children }: AddProjectButtonProps) {
  return <Button type="button" size="sm" variant={variant === "primary" ? "default" : "secondary"} disabled={disabled} onClick={onClick}>{children}</Button>;
}

function DeleteProjectButton({ variant, disabled, onClick, children }: ProjectDeleteButtonProps) {
  return <Button type="button" size="sm" variant={variant === "danger" ? "destructive" : "ghost"} disabled={disabled} onClick={onClick}>{children}</Button>;
}

// Mounted once per open, so the refreshed project list never outlives it.
function WebAddProjectForm({ gatewayUrl, scope, projects, onClose, onProjectAdded }: {
  gatewayUrl: string; scope: string; projects: readonly WebProject[]; onClose(): void; onProjectAdded(project: WebProject): void;
}) {
  const client = useMemo(() => createWebProjectClient(gatewayUrl), [gatewayUrl]);
  const refreshed = useRef<WebProject[] | null>(null);
  const createContext = (base: Pick<AddProjectSubmitContext<WebProject>, "isCurrent" | "setError" | "close">): AddProjectSubmitContext<WebProject> => ({
    getProjects: () => refreshed.current ?? projects,
    createProject: client.createProject,
    cloneProject: client.cloneProject,
    createFolder: client.createFolder,
    loadProjects: async () => {
      const list = await client.listProjects();
      if (list) refreshed.current = list;
      return list !== null;
    },
    // The web rail has no separate selection; opening the page selects it.
    selectProject: async () => undefined,
    openProject: onProjectAdded,
    isCurrent: base.isCurrent,
    setError: base.setError,
    close: base.close,
  });
  return <WebFolderPickerGateway.Provider value={gatewayUrl}>
    <AddProjectForm scope={scope} projects={projects} Button={AddProjectButton} FolderPicker={WebProjectFolderPicker}
      createContext={createContext} toErrorMessage={() => UNEXPECTED_FAILURE} onClose={onClose} folderRequestPrefix="req_web_folder_" />
  </WebFolderPickerGateway.Provider>;
}

export function WebAddProjectDialog({ open, ...props }: {
  open: boolean; gatewayUrl: string; scope: string; projects: readonly WebProject[]; onClose(): void; onProjectAdded(project: WebProject): void;
}) {
  return <Dialog open={open} onOpenChange={next => { if (!next) props.onClose(); }}>
    <DialogContent showCloseButton={false} aria-describedby={undefined} className="gap-0 overflow-hidden p-0 sm:max-w-[480px]" {...dialogLayer}>
      <DialogTitle className="sr-only">Create a project</DialogTitle>
      {open ? <WebAddProjectForm {...props} /> : null}
    </DialogContent>
  </Dialog>;
}

/** Deletes only after the gateway confirms; a failure keeps the project and the dialog. */
export function WebProjectDeleteDialog({ project, gatewayUrl, onClose, onDeleted }: {
  project: WebProject | null; gatewayUrl: string; onClose(): void; onDeleted(project: WebProject): void;
}) {
  const client = useMemo(() => createWebProjectClient(gatewayUrl), [gatewayUrl]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  useEffect(() => {
    generation.current += 1;
    setPending(false);
    setError(null);
  }, [gatewayUrl, project?.id]);

  const confirm = async (target: WebProject, confirmation: string) => {
    if (pending) return;
    const attempt = ++generation.current;
    setPending(true);
    setError(null);
    const result = await client.deleteProject(target.slug, confirmation);
    if (generation.current !== attempt) return;
    setPending(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    onDeleted(target);
    onClose();
  };

  return <Dialog open={project !== null} onOpenChange={next => { if (!next && !pending) onClose(); }}>
    <DialogContent role="alertdialog" aria-describedby={undefined} showCloseButton={false} className="gap-0 overflow-hidden p-0 sm:max-w-[440px]" {...dialogLayer}>
      <DialogTitle className="sr-only">Delete project permanently?</DialogTitle>
      {project ? <ProjectDeleteConfirmation key={project.id} project={project} pending={pending} error={error} available
        Button={DeleteProjectButton} onCancel={onClose} onConfirm={confirmation => void confirm(project, confirmation)} /> : null}
    </DialogContent>
  </Dialog>;
}
