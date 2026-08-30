import { Edit3 } from "@renderer/lib/hugeicons";
import { useEffect, useState } from "react";
import type { Project } from "../../stores/board";
import { useConnection } from "../../stores/connection";
import { useProjectLifecycle } from "../../stores/project-lifecycle";
import { Button, Dialog } from "../../design/primitives";

export default function ProjectRenameDialog({
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
  const renameProject = useProjectLifecycle((state) => state.renameProject);
  const [name, setName] = useState(project.name);
  const pending = pendingProjectSlug === project.slug;

  useEffect(() => {
    if (!open) return;
    setName(project.name);
    clearError();
  }, [clearError, open, project.name, project.slug]);

  const trimmedName = name.trim();
  const submit = async () => {
    if (!api || pending || !trimmedName || trimmedName === project.name) return;
    if (await renameProject(api, project.slug, trimmedName)) onClose();
  };

  return (
    <Dialog open={open} onClose={() => { if (!pending) onClose(); }} width={420} title="Rename project">
      <div className="flex items-start gap-3 border-b px-5 py-4" style={{ borderColor: "var(--border-subtle)" }}>
        <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg" style={{ color: "var(--accent)", background: "var(--bg-selected)" }}>
          <Edit3 size={16} aria-hidden />
        </span>
        <div>
          <h2 className="text-base font-semibold" style={{ color: "var(--text-primary)" }}>Rename project</h2>
          <p className="mt-1 text-sm" style={{ color: "var(--text-secondary)" }}>
            This changes the display name. The project slug, folder, chats, and terminal paths stay the same.
          </p>
        </div>
      </div>
      <div className="space-y-3 px-5 py-4">
        <label className="block text-sm font-medium" style={{ color: "var(--text-primary)" }}>
          Project name
          <input
            autoFocus
            aria-label="Project name"
            maxLength={128}
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter") void submit(); }}
            className="mt-2 h-9 w-full rounded-md border px-3 text-sm outline-none focus:border-[var(--accent)]"
            style={{ background: "var(--bg-surface)", borderColor: "var(--border-default)", color: "var(--text-primary)" }}
          />
        </label>
        {error ? <p role="alert" className="text-sm" style={{ color: "var(--danger)" }}>{error}</p> : null}
      </div>
      <div className="flex justify-end gap-2 border-t px-5 py-3" style={{ borderColor: "var(--border-subtle)" }}>
        <Button variant="ghost" disabled={pending} onClick={onClose}>Cancel</Button>
        <Button disabled={!api || pending || !trimmedName || trimmedName === project.name} onClick={() => void submit()}>
          {pending ? "Saving…" : "Rename"}
        </Button>
      </div>
    </Dialog>
  );
}
