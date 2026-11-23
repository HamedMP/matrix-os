"use client";

// Web Desktop and Web Canvas chrome for the shared add-project and
// delete-project flows. Behavior, copy, and validation come from @matrix-os/ui.
import {
  AddProjectForm, ProjectDeleteConfirmation, ProjectEditForm,
  type AddProjectButtonProps, type AddProjectSubmitContext, type ProjectDeleteButtonProps, type ProjectEditButtonProps, type ProjectShareAvailability,
} from "@matrix-os/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { SHELL_Z_INDEX } from "@/lib/shell-layering";
import { createWebProjectClient } from "./web-project-client";
import { WebFolderPickerGateway } from "./web-folder-picker-gateway";
import { WebProjectFolderPicker } from "./WebProjectFolderPicker";
import type { WebProject } from "./web-projects";

const UNEXPECTED_FAILURE = "Something went wrong. Please try again.";
const dialogLayer = { style: { zIndex: SHELL_Z_INDEX.appDialog }, overlayStyle: { zIndex: SHELL_Z_INDEX.appDialog } };

function AddProjectButton({ variant, disabled, onClick, children }: AddProjectButtonProps) {
  return <Button type="button" size="sm" variant={variant === "primary" ? "default" : "secondary"} disabled={disabled} onClick={onClick}>{children}</Button>;
}

function EditProjectButton({ variant, type, disabled, onClick, children }: ProjectEditButtonProps) {
  return <Button type={type} size="sm" variant={variant === "primary" ? "default" : "secondary"} disabled={disabled} onClick={onClick}>{children}</Button>;
}

function DeleteProjectButton({ variant, disabled, onClick, children }: ProjectDeleteButtonProps) {
  return <Button type="button" size="sm" variant={variant === "danger" ? "destructive" : "ghost"} disabled={disabled} onClick={onClick}>{children}</Button>;
}

// Mounted once per open, so the refreshed project list never outlives it.
type AddProjectDialogProps = {
  gatewayUrl: string; scope: string; projects: readonly WebProject[]; shareAvailability: ProjectShareAvailability;
  onClose(): void; onProjectAdded(project: WebProject): void; onShareCreated(project: WebProject): void;
};

function WebAddProjectForm({ gatewayUrl, scope, projects, shareAvailability, onClose, onProjectAdded, onShareCreated }: AddProjectDialogProps) {
  const client = useMemo(() => createWebProjectClient(gatewayUrl), [gatewayUrl]);
  const refreshed = useRef<WebProject[] | null>(null);
  const createContext = ({ shareRequested, ...base }: Pick<AddProjectSubmitContext<WebProject>, "isCurrent" | "setError" | "close"> & { shareRequested: boolean }): AddProjectSubmitContext<WebProject> => ({
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
    // The sharing flow mounts outside this dialog, which closes after a successful create.
    ...(shareRequested ? { onCreatedProject: onShareCreated } : {}),
  });
  return <WebFolderPickerGateway.Provider value={gatewayUrl}>
    <AddProjectForm scope={scope} projects={projects} Button={AddProjectButton} FolderPicker={WebProjectFolderPicker}
      createContext={createContext} toErrorMessage={() => UNEXPECTED_FAILURE} onClose={onClose} shareAvailability={shareAvailability}
      folderRequestPrefix="req_web_folder_" />
  </WebFolderPickerGateway.Provider>;
}

export function WebAddProjectDialog({ open, ...props }: AddProjectDialogProps & { open: boolean }) {
  return <Dialog open={open} onOpenChange={next => { if (!next) props.onClose(); }}>
    <DialogContent showCloseButton={false} aria-describedby={undefined} className="gap-0 overflow-hidden p-0 sm:max-w-[480px]" {...dialogLayer}>
      <DialogTitle className="sr-only">Create a project</DialogTitle>
      {open ? <WebAddProjectForm {...props} /> : null}
    </DialogContent>
  </Dialog>;
}

// Mounted per target and computer, so pending state and errors never carry over.
function WebProjectDeleteBody({ project, gatewayUrl, onClose, onDeleted, onPendingChange }: {
  project: WebProject; gatewayUrl: string; onClose(): void; onDeleted(project: WebProject): void; onPendingChange(pending: boolean): void;
}) {
  const client = useMemo(() => createWebProjectClient(gatewayUrl), [gatewayUrl]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  const releasePending = useRef(onPendingChange);
  useEffect(() => {
    mounted.current = true;
    const release = releasePending.current;
    return () => {
      mounted.current = false;
      release(false);
    };
  }, []);

  const confirm = (confirmation: string) => {
    if (pending) return;
    setPending(true);
    onPendingChange(true);
    setError(null);
    void client.deleteProject(project.slug, confirmation).then(result => {
      if (!mounted.current) return;
      if (!result.ok) {
        setError(result.message);
        return;
      }
      // Local state changes only after the gateway confirmed the deletion.
      onDeleted(project);
      onClose();
    }).finally(() => {
      if (!mounted.current) return;
      setPending(false);
      onPendingChange(false);
    });
  };

  return <ProjectDeleteConfirmation project={project} pending={pending} error={error} available
    Button={DeleteProjectButton} onCancel={onClose} onConfirm={confirm} />;
}

/** Deletes only after the gateway confirms; a failure keeps the project and the dialog. */
export function WebProjectDeleteDialog({ project, gatewayUrl, onClose, onDeleted }: {
  project: WebProject | null; gatewayUrl: string; onClose(): void; onDeleted(project: WebProject): void;
}) {
  const pending = useRef(false);
  return <Dialog open={project !== null} onOpenChange={next => { if (!next && !pending.current) onClose(); }}>
    <DialogContent role="alertdialog" aria-describedby={undefined} showCloseButton={false} className="gap-0 overflow-hidden p-0 sm:max-w-[440px]" {...dialogLayer}>
      <DialogTitle className="sr-only">Delete project permanently?</DialogTitle>
      {project ? <WebProjectDeleteBody key={`${gatewayUrl}\n${project.id}`} project={project} gatewayUrl={gatewayUrl}
        onClose={onClose} onDeleted={onDeleted} onPendingChange={value => { pending.current = value; }} /> : null}
    </DialogContent>
  </Dialog>;
}

/** Saves only after the gateway confirms; a failure keeps the dialog and the typed values. */
export function WebProjectEditDialog({ project, pending, error, onClose, onSave }: {
  project: WebProject; pending: boolean; error: string | null; onClose(): void; onSave(patch: { name: string; description: string }): Promise<boolean>;
}) {
  return <Dialog open onOpenChange={next => { if (!next && !pending) onClose(); }}>
    <DialogContent aria-describedby={undefined} showCloseButton={false} className="gap-0 overflow-hidden p-0 sm:max-w-[440px]" {...dialogLayer}>
      <DialogTitle className="sr-only">Edit project</DialogTitle>
      <ProjectEditForm project={project} pending={pending} error={error} Button={EditProjectButton} onClose={onClose} onSave={onSave} />
    </DialogContent>
  </Dialog>;
}
