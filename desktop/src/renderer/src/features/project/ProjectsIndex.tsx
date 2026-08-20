import { Search } from "lucide-react";
import { useMemo, useState } from "react";
import { useCodingAgentWorkspace } from "../../stores/coding-agent-workspace";
import { useBoard, type Project } from "../../stores/board";
import { useTabs } from "../../stores/tabs";
import { useUi } from "../../stores/ui";

function projectCaption(project: Project): string {
  if (project.description) return project.description;
  if (project.kind === "github") return "GitHub repository";
  if (project.kind === "folder") return "Connected folder on this computer";
  return "Local project on this computer";
}

function projectDate(project: Project, summaryUpdatedAt?: string): string {
  const value = project.updatedAt ?? summaryUpdatedAt;
  if (!value) return "";
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "";
  const days = Math.floor((Date.now() - timestamp) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "1 day ago";
  if (days < 7) return `${days} days ago`;
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(timestamp);
}

export default function ProjectsIndex() {
  const projects = useBoard((state) => state.projects);
  const summaryProjects = useCodingAgentWorkspace((state) => state.summary?.projects.items);
  const openTab = useTabs((state) => state.openTab);
  const setCreateProjectOpen = useUi((state) => state.setCreateProjectOpen);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const visibleProjects = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return projects;
    return projects.filter((project) => `${project.name} ${project.slug} ${project.description ?? ""}`.toLocaleLowerCase().includes(normalized));
  }, [projects, query]);

  return (
    <main className="min-h-0 flex-1 overflow-y-auto" style={{ background: "var(--bg-app)" }}>
      <div className="mx-auto flex w-full max-w-[920px] flex-col px-8 pb-12 pt-10">
        <div className="mb-5 flex items-center gap-3">
          <h1 className="text-[32px] leading-none tracking-[-0.035em]" style={{ color: "var(--text-primary)", fontFamily: "var(--font-editorial)" }}>
            Projects
          </h1>
          <div className="flex-1" />
          {searchOpen ? (
            <label className="relative">
              <span className="sr-only">Search projects</span>
              <Search aria-hidden="true" size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2" style={{ color: "var(--text-tertiary)" }} />
              <input
                autoFocus
                aria-label="Search projects"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onBlur={() => { if (!query) setSearchOpen(false); }}
                className="h-8 w-52 rounded-md border bg-transparent pl-8 pr-2 text-sm outline-none focus:border-[var(--accent)]"
                style={{ borderColor: "var(--border-default)", color: "var(--text-primary)" }}
              />
            </label>
          ) : (
            <button
              type="button"
              aria-label="Search projects"
              className="flex h-8 w-8 items-center justify-center rounded-md border hover:bg-[var(--bg-hover)]"
              style={{ borderColor: "var(--border-subtle)", color: "var(--text-secondary)" }}
              onClick={() => setSearchOpen(true)}
            >
              <Search size={15} />
            </button>
          )}
          <button
            type="button"
            className="h-8 rounded-md px-3 text-sm font-medium"
            style={{ background: "var(--accent)", color: "var(--text-on-accent)" }}
            onClick={() => setCreateProjectOpen(true)}
          >
            New
          </button>
        </div>

        {visibleProjects.length > 0 ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {visibleProjects.map((project) => {
              const summary = summaryProjects?.find((candidate) => candidate.id === project.slug);
              return (
                <button
                  key={project.slug}
                  type="button"
                  aria-label={`Open project ${project.name}`}
                  className="group flex min-h-[136px] flex-col rounded-xl border p-4 text-left outline-none transition-[border-color,background-color] hover:border-[var(--text-primary)] hover:bg-[var(--bg-hover)] focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                  style={{ borderColor: "var(--border-subtle)", background: "var(--bg-surface)" }}
                  onClick={() => openTab({ kind: "project", projectSlug: project.slug, title: project.name || project.slug })}
                >
                  <span className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>{project.name}</span>
                  <span className="mt-2 line-clamp-2 text-xs leading-5" style={{ color: "var(--text-tertiary)" }}>{projectCaption(project)}</span>
                  <span className="mt-auto text-xs" style={{ color: "var(--text-tertiary)" }}>{projectDate(project, summary?.updatedAt)}</span>
                </button>
              );
            })}
          </div>
        ) : (
          <div className="rounded-xl border px-5 py-10 text-center" style={{ borderColor: "var(--border-subtle)", color: "var(--text-tertiary)" }}>
            {query ? "No projects match your search." : "Create your first project to get started."}
          </div>
        )}
      </div>
    </main>
  );
}
