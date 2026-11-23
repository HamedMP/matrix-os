import { ProjectEditForm, type ProjectEditButtonProps } from "@matrix-os/ui";
import type { RefObject } from "react";
import { Button, Dialog } from "../../../design/primitives";
import type { Project } from "../../../stores/board";

function EditButton({ variant, type, disabled, onClick, children }: ProjectEditButtonProps) {
  return <Button type={type} variant={variant} disabled={disabled} onClick={onClick}>{children}</Button>;
}

export function ProjectEditDialog({ project, pending, error, onClose, onSave, returnFocusRef }: {
  project: Project;
  returnFocusRef: RefObject<HTMLButtonElement | null>;
  pending: boolean;
  error: string | null;
  onClose(): void;
  onSave(patch: { name: string; description: string }): Promise<boolean>;
}) {
  return <Dialog open title="Edit project" onClose={() => { if (!pending) onClose(); }} width={440} onCloseAutoFocus={event => { event.preventDefault(); returnFocusRef.current?.focus(); }}>
    <ProjectEditForm project={project} pending={pending} error={error} Button={EditButton} onClose={onClose} onSave={onSave} />
  </Dialog>;
}
