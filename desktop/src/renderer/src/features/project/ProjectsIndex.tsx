import { Folder, GitBranch, GitFork, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { z } from "zod/v4";
import { useCodingAgentWorkspace } from "../../stores/coding-agent-workspace";
import { useBoard, type Project } from "../../stores/board";
import { useConnection } from "../../stores/connection";
import { useProjectView } from "../../stores/project-view";
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

const ProjectCodeMetadataSchema = z.object({
  path: z.string().min(1).max(4096),
  repository: z.string().min(1).max(512).nullable(),
  isGitRepository: z.boolean(),
  branch: z.string().min(1).max(200).nullable(),
  clean: z.boolean().nullable(),
  ahead: z.number().int().min(0).max(1_000_000),
  behind: z.number().int().min(0).max(1_000_000),
  hasUpstream: z.boolean(),
  worktreeCount: z.number().int().min(0).max(10_000).nullable(),
});

type ProjectCodeMetadata = z.infer<typeof ProjectCodeMetadataSchema>;

function ProjectCard(props: {
  project: Project;
  summaryUpdatedAt?: string;
  onOpen: () => void;
}) {
  const { project, summaryUpdatedAt, onOpen } = props;
  const api = useConnection((state) => state.api);
  const [metadata, setMetadata] = useState<ProjectCodeMetadata | null>(null);

  useEffect(() => {
    let active = true;
    setMetadata(null);
    if (!api) return () => { active = false; };
    void api.get<unknown>(`/api/projects/${encodeURIComponent(project.slug)}/code-metadata`)
      .then((value) => {
        if (!active) return;
        const parsed = ProjectCodeMetadataSchema.safeParse(value);
        if (parsed.success) setMetadata(parsed.data);
        else console.warn("[projects-index] Ignoring invalid project code metadata");
      })
      .catch((err: unknown) => {
        if (active) console.warn("[projects-index] Project code metadata unavailable:", err instanceof Error ? err.name : typeof err);
      });
    return () => { active = false; };
  }, [api, project.slug]);

  const path = metadata?.path ?? project.localPath;
  const repository = metadata?.repository ?? project.repository;
  const branch = metadata?.branch ?? project.defaultBranch;
  const isGitRepository = metadata?.isGitRepository ?? project.githubBacked ?? project.kind === "github";
  return (
    <button
      type="button"
      aria-label={`Open project ${project.name}`}
      className="group flex min-h-[176px] flex-col rounded-xl border p-4 text-left outline-none transition-[border-color,background-color] hover:border-[var(--text-primary)] hover:bg-[var(--bg-hover)] focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
      style={{ borderColor: "var(--border-subtle)", background: "var(--bg-surface)" }}
      onClick={onOpen}
    >
      <span className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>{project.name}</span>
      <span className="mt-1.5 line-clamp-2 text-xs leading-5" style={{ color: "var(--text-tertiary)" }}>{projectCaption(project)}</span>
      {path ? (
        <span className="mt-2 flex min-w-0 items-center gap-1.5 text-[11px]" style={{ color: "var(--text-tertiary)" }} title={path}>
          <Folder aria-hidden="true" size={12} className="shrink-0" />
          <span className="truncate">{path}</span>
        </span>
      ) : null}
      {isGitRepository ? (
        <span className="mt-1.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[11px]" style={{ color: "var(--text-secondary)" }}>
          {repository ? <span className="max-w-[210px] truncate font-medium">{repository}</span> : null}
          {branch ? (
            <span className="flex min-w-0 items-center gap-1">
              <GitBranch aria-hidden="true" size={12} className="shrink-0" />
              <span className="max-w-[150px] truncate">{branch}</span>
            </span>
          ) : null}
        </span>
      ) : null}
      {metadata?.isGitRepository ? (
        <span className="mt-1.5 flex flex-wrap items-center gap-2 text-[10px]" style={{ color: "var(--text-tertiary)" }}>
          {metadata.clean !== null ? <span>{metadata.clean ? "Clean" : "Changes"}</span> : null}
          {metadata.ahead > 0 ? <span>{metadata.ahead} ahead</span> : null}
          {metadata.behind > 0 ? <span>{metadata.behind} behind</span> : null}
          {metadata.worktreeCount !== null && metadata.worktreeCount > 0 ? (
            <span className="flex items-center gap-1">
              <GitFork aria-hidden="true" size={11} />
              {metadata.worktreeCount} {metadata.worktreeCount === 1 ? "worktree" : "worktrees"}
            </span>
          ) : null}
        </span>
      ) : null}
      <span className="mt-auto pt-2 text-xs" style={{ color: "var(--text-tertiary)" }}>{projectDate(project, summaryUpdatedAt)}</span>
    </button>
  );
}

export default function ProjectsIndex() {
  const projects = useBoard((state) => state.projects);
  const summaryProjects = useCodingAgentWorkspace((state) => state.summary?.projects.items);
  const openTab = useTabs((state) => state.openTab);
  const setProjectView = useProjectView((state) => state.setView);
  const setCreateProjectOpen = useUi((state) => state.setCreateProjectOpen);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const visibleProjects = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return projects;
    return projects.filter((project) => `${project.name} ${project.slug} ${project.description ?? ""} ${project.localPath ?? ""} ${project.repository ?? ""}`.toLocaleLowerCase().includes(normalized));
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
                <ProjectCard
                  key={project.slug}
                  project={project}
                  summaryUpdatedAt={summary?.updatedAt}
                  onOpen={() => {
                    setProjectView(project.slug, "overview");
                    openTab({ kind: "project", projectSlug: project.slug, title: project.name || project.slug });
                  }}
                />
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
