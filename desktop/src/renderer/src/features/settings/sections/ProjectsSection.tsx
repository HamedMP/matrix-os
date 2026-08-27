import { ArchiveRestore, FolderArchive, Trash2 } from "@renderer/lib/hugeicons";
import { useEffect, useState } from "react";
import { Button } from "../../../design/primitives";
import { useConnection } from "../../../stores/connection";
import { useProjectLifecycle } from "../../../stores/project-lifecycle";
import type { Project } from "../../../stores/board";
import ProjectLifecycleDialog from "../../mission-control/ProjectLifecycleDialog";

const KIND_LABELS: Record<Project["kind"], string> = {
  scratch: "Matrix workspace",
  github: "GitHub repository",
  folder: "Connected folder",
};

export default function ProjectsSection() {
  const api = useConnection((state) => state.api);
  const projects = useProjectLifecycle((state) => state.archivedProjects);
  const loading = useProjectLifecycle((state) => state.loading);
  const pendingProjectSlug = useProjectLifecycle((state) => state.pendingProjectSlug);
  const error = useProjectLifecycle((state) => state.error);
  const loadArchivedProjects = useProjectLifecycle((state) => state.loadArchivedProjects);
  const restoreProject = useProjectLifecycle((state) => state.restoreProject);
  const [deleteTarget, setDeleteTarget] = useState<Project | null>(null);

  useEffect(() => {
    if (api) void loadArchivedProjects(api);
  }, [api, loadArchivedProjects]);

  return (
    <section>
      <div className="mb-6">
        <h3 className="text-xl font-semibold tracking-tight" style={{ color: "var(--text-primary)" }}>Archived projects</h3>
        <p className="mt-1 text-sm" style={{ color: "var(--text-secondary)" }}>
          Restore projects to the sidebar or permanently remove their Matrix OS data.
        </p>
      </div>

      {loading && projects.length === 0 ? (
        <p className="text-sm" style={{ color: "var(--text-secondary)" }}>Loading archived projects…</p>
      ) : null}
      {!loading && projects.length === 0 ? (
        <div className="flex flex-col items-center rounded-xl border px-6 py-10 text-center" style={{ borderColor: "var(--border-subtle)", background: "var(--bg-surface)" }}>
          <FolderArchive size={24} style={{ color: "var(--text-tertiary)" }} />
          <p className="mt-3 text-sm font-medium" style={{ color: "var(--text-primary)" }}>No archived projects</p>
          <p className="mt-1 text-sm" style={{ color: "var(--text-secondary)" }}>Projects archived from the sidebar will appear here.</p>
        </div>
      ) : null}

      <div className="space-y-2">
        {projects.map((project) => {
          const pending = pendingProjectSlug === project.slug;
          return (
            <div key={project.slug} className="flex items-center gap-3 rounded-xl border px-4 py-3" style={{ borderColor: "var(--border-subtle)", background: "var(--bg-surface)" }}>
              <span className="flex h-8 w-8 items-center justify-center rounded-lg" style={{ background: "var(--accent-muted)", color: "var(--accent)" }}>
                <FolderArchive size={16} />
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold" style={{ color: "var(--text-primary)" }}>{project.name}</p>
                <p className="mt-0.5 text-xs" style={{ color: "var(--text-tertiary)" }}>
                  {KIND_LABELS[project.kind]}
                  {project.archivedAt ? ` · Archived ${new Date(project.archivedAt).toLocaleDateString()}` : ""}
                </p>
              </div>
              <Button
                variant="subtle"
                aria-label={`Restore ${project.name}`}
                disabled={!api || pending}
                onClick={() => { if (api) void restoreProject(api, project.slug); }}
              >
                <ArchiveRestore size={14} /> Restore
              </Button>
              <Button
                variant="ghost"
                aria-label={`Delete ${project.name}`}
                disabled={pending}
                style={{ color: "var(--danger)" }}
                onClick={() => setDeleteTarget(project)}
              >
                <Trash2 size={14} />
              </Button>
            </div>
          );
        })}
      </div>

      {error ? <p role="alert" className="mt-3 text-sm" style={{ color: "var(--danger)" }}>{error}</p> : null}
      {deleteTarget ? (
        <ProjectLifecycleDialog
          open
          project={deleteTarget}
          onClose={() => setDeleteTarget(null)}
        />
      ) : null}
    </section>
  );
}
