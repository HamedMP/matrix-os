import { Trash2 } from "@renderer/lib/hugeicons";
import { useEffect, useState } from "react";
import type { Project } from "../../stores/board";
import { useConnection } from "../../stores/connection";
import { useProjectLifecycle } from "../../stores/project-lifecycle";
import { Button, Dialog } from "../../design/primitives";

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
  const [confirmation, setConfirmation] = useState("");
  const pending = pendingProjectSlug === project.slug;

  useEffect(() => {
    if (open) {
      setConfirmation("");
      clearError();
    }
  }, [clearError, open, project.slug]);

  const submit = async () => {
    if (!api || pending) return;
    const succeeded = await deleteProject(api, project.slug, confirmation);
    if (succeeded) onClose();
  };

  const deleteEnabled = confirmation === project.name;

  return (
    <Dialog open={open} onClose={() => { if (!pending) onClose(); }} width={440}>
      <div className="flex items-start gap-3 border-b px-5 py-4" style={{ borderColor: "var(--border-subtle)" }}>
        <span
          className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg"
          style={{
            color: "var(--danger)",
            background: "var(--danger-muted)",
          }}
        >
          <Trash2 size={16} />
        </span>
        <div>
          <h2 className="text-base font-semibold" style={{ color: "var(--text-primary)" }}>
            Delete project permanently?
          </h2>
          <p className="mt-1 text-sm" style={{ color: "var(--text-secondary)" }}>
            This permanently removes Matrix OS data for {project.name}.
          </p>
        </div>
      </div>

      <div className="space-y-3 px-5 py-4">
        <p className="rounded-lg p-3 text-sm" style={{ background: "var(--bg-sunken)", color: "var(--text-secondary)" }}>
          {project.kind === "folder"
            ? "Matrix OS will remove its project record, tasks, chats, and internal state. Your original folder and files will stay untouched."
            : "The managed workspace, tasks, chats, reviews, previews, and worktrees will be removed."}
        </p>
        <label className="block text-sm font-medium" style={{ color: "var(--text-primary)" }}>
          Type {project.name} to confirm
          <input
            aria-label={`Type ${project.name} to confirm`}
            autoComplete="off"
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
            className="mt-2 h-9 w-full rounded-md border px-3 text-sm outline-none focus:border-[var(--accent)]"
            style={{ background: "var(--bg-surface)", borderColor: "var(--border-default)", color: "var(--text-primary)" }}
          />
        </label>
        {error ? <p role="alert" className="text-sm" style={{ color: "var(--danger)" }}>{error}</p> : null}
      </div>

      <div className="flex justify-end gap-2 border-t px-5 py-3" style={{ borderColor: "var(--border-subtle)" }}>
        <Button variant="ghost" disabled={pending} onClick={onClose}>Cancel</Button>
        <Button
          variant="danger"
          disabled={!api || pending || !deleteEnabled}
          onClick={() => void submit()}
        >
          {pending ? "Working…" : "Delete project"}
        </Button>
      </div>
    </Dialog>
  );
}
