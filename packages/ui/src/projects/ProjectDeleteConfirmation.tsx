// Body of the "Delete project permanently?" dialog, shared by Electron Desktop
// and the web OS views. The OS view owns the dialog chrome and the request.
import { Trash2 } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState, type ComponentType, type ReactNode } from "react";

export interface ProjectDeleteButtonProps {
  variant: "ghost" | "danger";
  disabled?: boolean;
  onClick(): void;
  children: ReactNode;
}

export function ProjectDeleteConfirmation({ project, pending, error, available, Button, onCancel, onConfirm }: {
  project: { name: string; kind?: "scratch" | "github" | "folder" };
  pending: boolean;
  error: string | null;
  available: boolean;
  Button: ComponentType<ProjectDeleteButtonProps>;
  onCancel(): void;
  onConfirm(confirmation: string): void;
}) {
  const [confirmation, setConfirmation] = useState("");
  const deleteEnabled = confirmation === project.name;
  return <>
    <div className="flex items-start gap-3 border-b px-5 py-4" style={{ borderColor: "var(--border-subtle)" }}>
      <span
        className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg"
        style={{ color: "var(--danger-text, var(--destructive))", background: "var(--danger-muted, color-mix(in srgb, var(--destructive) 12%, transparent))" }}
      >
        <HugeiconsIcon icon={Trash2} size={16} strokeWidth={1.5} />
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
      <p className="text-sm" style={{ color: "var(--text-secondary)" }}>
        This will stop project tasks and terminal sessions and delete all associated chats and sessions.
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
      {error ? <p role="alert" className="text-sm" style={{ color: "var(--danger-text, var(--destructive))" }}>{error}</p> : null}
    </div>

    <div className="flex justify-end gap-2 border-t px-5 py-3" style={{ borderColor: "var(--border-subtle)" }}>
      <Button variant="ghost" disabled={pending} onClick={onCancel}>Cancel</Button>
      <Button variant="danger" disabled={!available || pending || !deleteEnabled} onClick={() => onConfirm(confirmation)}>
        {pending ? "Working…" : "Delete project"}
      </Button>
    </div>
  </>;
}
