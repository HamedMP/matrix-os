import { useRef, type ReactNode } from "react";
import { FolderOpen, PencilEditIcon } from "@renderer/lib/hugeicons";
import type { Project } from "../../stores/board";
import { ProjectEditDialog } from "../work/work-rail/ProjectActionDialogs";
import { useProjectActions } from "../work/work-rail/use-project-actions";

/** Project metadata surrounds the existing canonical draft; its provider and draft stay authoritative. */
export function ProjectLanding({ project, children, showMetadata = true }: { project: Project; children: ReactNode; showMetadata?: boolean }) {
  const actions = useProjectActions(project);
  const editButtonRef = useRef<HTMLButtonElement>(null);
  return <div className="@container/project-landing flex h-full min-h-0 min-w-0 w-full flex-1 flex-col">
    {showMetadata ? <header className="mx-auto w-full max-w-3xl shrink-0 px-6 pb-2 pt-8">
      <div className="mb-5 flex items-center gap-3">
        <FolderOpen size={22} aria-hidden style={{ color: "var(--text-tertiary)" }} />
        <h1 className="truncate text-2xl font-semibold" style={{ color: "var(--text-primary)" }}>{project.name}</h1>
      </div>
      <div className="grid grid-cols-1 gap-3 @min-[34rem]/project-landing:grid-cols-2">
        <button ref={editButtonRef} type="button" aria-label={`Edit ${project.name} description`} disabled={!actions.available || actions.pending}
          className="rounded-xl border p-4 text-left outline-none transition-colors hover:bg-[var(--bg-hover)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-50"
          style={{ borderColor: "var(--border-subtle)" }} onClick={() => actions.setDialog("edit")}>
          <span className="mb-2 flex items-center gap-2 text-sm font-medium"><PencilEditIcon size={16} aria-hidden />Description</span>
          <span className="line-clamp-2 text-xs" style={{ color: "var(--text-tertiary)" }}>{project.description || "Add a description for this project"}</span>
        </button>
        <button type="button" aria-label={`Open ${project.name} files`} disabled={!actions.available || actions.pending}
          className="rounded-xl border p-4 text-left outline-none transition-colors hover:bg-[var(--bg-hover)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-50"
          style={{ borderColor: "var(--border-subtle)" }} onClick={() => { void actions.showInFiles(); }}>
          <span className="mb-2 flex items-center gap-2 text-sm font-medium"><FolderOpen size={16} aria-hidden />Files</span>
          <span className="text-xs" style={{ color: "var(--text-tertiary)" }}>Browse project files</span>
        </button>
      </div>
      {actions.error && actions.dialog !== "edit" ? <p role="alert" className="mt-2 text-xs" style={{ color: "var(--danger)" }}>{actions.error}</p> : null}
    </header> : null}
    <div className="min-h-0 flex-1">{children}</div>
    {actions.dialog === "edit" ? <ProjectEditDialog project={project} returnFocusRef={editButtonRef} pending={actions.pending} error={actions.error} onClose={() => actions.setDialog(null)} onSave={actions.update} /> : null}
  </div>;
}
