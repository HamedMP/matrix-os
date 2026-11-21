import { ProjectDeleteConfirmation, type ProjectDeleteButtonProps } from "@matrix-os/ui";
import { useEffect } from "react";
import type { Project } from "../../stores/board";
import { useConnection } from "../../stores/connection";
import { useProjectLifecycle } from "../../stores/project-lifecycle";
import { Button, Dialog } from "../../design/primitives";

function DeleteButton({ variant, disabled, onClick, children }: ProjectDeleteButtonProps) {
  return <Button variant={variant} disabled={disabled} onClick={onClick}>{children}</Button>;
}

export default function ProjectLifecycleDialog({
  open,
  project,
  onClose,
}: {
  open: boolean;
  project: Project;
  onClose: () => void;
}) {
  const api = useConnection((state) => state.api);
  const pendingProjectSlug = useProjectLifecycle((state) => state.pendingProjectSlug);
  const error = useProjectLifecycle((state) => state.error);
  const clearError = useProjectLifecycle((state) => state.clearError);
  const deleteProject = useProjectLifecycle((state) => state.deleteProject);
  const pending = pendingProjectSlug === project.slug;

  useEffect(() => {
    if (open) clearError();
  }, [clearError, open, project.slug]);

  const submit = async (confirmation: string) => {
    if (!api || pending) return;
    const succeeded = await deleteProject(api, project.slug, confirmation);
    if (succeeded) onClose();
  };

  return (
    <Dialog
      open={open}
      onClose={() => { if (!pending) onClose(); }}
      width={440}
      title="Delete project permanently?"
      role="alertdialog"
    >
      {open ? <ProjectDeleteConfirmation key={project.slug} project={project} pending={pending} error={error} available={Boolean(api)}
        Button={DeleteButton} onCancel={onClose} onConfirm={(confirmation) => void submit(confirmation)} /> : null}
    </Dialog>
  );
}
