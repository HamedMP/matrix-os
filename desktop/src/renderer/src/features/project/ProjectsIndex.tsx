import { AlertCircle, Folder, GitBranch, GitFork, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { z } from "zod/v4";
import { useCodingAgentWorkspace } from "../../stores/coding-agent-workspace";
import { useBoard, type Project } from "../../stores/board";
import { useConnection } from "../../stores/connection";
import { useUi } from "../../stores/ui";
import { AppError } from "../../../../shared/app-error";
import type { ApiClient } from "../../lib/api";
import { toUserMessage } from "../../lib/errors";
import { openProjectOverview } from "../../lib/project-navigation";
import { Button, EmptyState } from "../../design/primitives";

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

const PROJECTS_PAGE_SIZE = 24;
const PROJECT_METADATA_CONCURRENCY = 4;
const PROJECT_METADATA_QUEUE_LIMIT = PROJECTS_PAGE_SIZE;
const PROJECT_METADATA_CACHE_MS = 30_000;
const PROJECT_METADATA_CACHE_LIMIT = 48;

interface MetadataTask {
  cancelled: boolean;
  run: () => Promise<ProjectCodeMetadata | null>;
  resolve: (value: ProjectCodeMetadata | null) => void;
  reject: (error: unknown) => void;
}

const metadataQueue: MetadataTask[] = [];
let activeMetadataRequests = 0;
const metadataCache = new WeakMap<object, Map<string, { value: ProjectCodeMetadata | null; expiresAt: number }>>();

function drainMetadataQueue(): void {
  while (activeMetadataRequests < PROJECT_METADATA_CONCURRENCY && metadataQueue.length > 0) {
    const task = metadataQueue.shift();
    if (!task || task.cancelled) continue;
    activeMetadataRequests += 1;
    void task.run()
      .then(task.resolve, task.reject)
      .finally(() => {
        activeMetadataRequests -= 1;
        drainMetadataQueue();
      });
  }
}

function scheduleProjectMetadata(api: ApiClient, slug: string) {
  let task: MetadataTask | null = null;
  const apiCache = metadataCache.get(api);
  const cached = apiCache?.get(slug);
  if (cached && cached.expiresAt > Date.now()) {
    return { promise: Promise.resolve(cached.value), cancel: () => undefined };
  }
  if (cached) apiCache?.delete(slug);
  const promise = new Promise<ProjectCodeMetadata | null>((resolve, reject) => {
    if (metadataQueue.length >= PROJECT_METADATA_QUEUE_LIMIT) {
      reject(new Error("project_metadata_queue_full"));
      return;
    }
    task = {
      cancelled: false,
      resolve,
      reject,
      run: async () => {
        const value = await api.get<unknown>(`/api/projects/${encodeURIComponent(slug)}/code-metadata`);
        const parsed = ProjectCodeMetadataSchema.safeParse(value);
        const metadata = parsed.success ? parsed.data : null;
        let cache = metadataCache.get(api);
        if (!cache) {
          cache = new Map();
          metadataCache.set(api, cache);
        }
        if (!cache.has(slug) && cache.size >= PROJECT_METADATA_CACHE_LIMIT) {
          const oldestKey = cache.keys().next().value;
          if (oldestKey !== undefined) cache.delete(oldestKey);
        }
        cache.set(slug, { value: metadata, expiresAt: Date.now() + PROJECT_METADATA_CACHE_MS });
        return metadata;
      },
    };
    metadataQueue.push(task);
    drainMetadataQueue();
  });
  return {
    promise,
    cancel: () => {
      if (!task || task.cancelled) return;
      task.cancelled = true;
      const queuedIndex = metadataQueue.indexOf(task);
      if (queuedIndex >= 0) {
        metadataQueue.splice(queuedIndex, 1);
        task.reject(new DOMException("Project metadata request cancelled", "AbortError"));
      }
    },
  };
}

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
    const request = scheduleProjectMetadata(api, project.slug);
    void request.promise
      .then((value) => {
        if (!active) return;
        if (value) setMetadata(value);
      })
      .catch((err: unknown) => {
        if (active && (!(err instanceof DOMException) || err.name !== "AbortError")) {
          console.warn("[projects-index] Project code metadata unavailable:", err instanceof Error ? err.name : typeof err);
        }
      });
    return () => {
      active = false;
      request.cancel();
    };
  }, [api, project.slug]);

  const path = metadata?.path ?? project.localPath;
  const repository = metadata?.repository ?? project.repository;
  const branch = metadata?.branch ?? project.defaultBranch;
  const isGitRepository = metadata?.isGitRepository ?? project.githubBacked ?? project.kind === "github";
  return (
    <button
      type="button"
      aria-label={`Open project ${project.name}`}
      className="group flex min-h-[176px] w-full flex-col rounded-xl border p-4 text-left outline-none transition-[border-color,background-color] hover:border-[var(--text-primary)] hover:bg-[var(--bg-hover)] focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
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
  const projectsStatus = useBoard((state) => state.projectsStatus);
  const projectsError = useBoard((state) => state.projectsError);
  const loadProjects = useBoard((state) => state.loadProjects);
  const api = useConnection((state) => state.api);
  const summaryProjects = useCodingAgentWorkspace((state) => state.summary?.projects.items);
  const setCreateProjectOpen = useUi((state) => state.setCreateProjectOpen);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [projectPage, setProjectPage] = useState(0);
  const visibleProjects = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return projects;
    return projects.filter((project) => `${project.name} ${project.slug} ${project.description ?? ""} ${project.localPath ?? ""} ${project.repository ?? ""}`.toLocaleLowerCase().includes(normalized));
  }, [projects, query]);
  const lastProjectPage = Math.max(0, Math.ceil(visibleProjects.length / PROJECTS_PAGE_SIZE) - 1);
  const currentProjectPage = Math.min(projectPage, lastProjectPage);
  const pageStart = currentProjectPage * PROJECTS_PAGE_SIZE;
  const pagedProjects = visibleProjects.slice(pageStart, pageStart + PROJECTS_PAGE_SIZE);

  useEffect(() => {
    setProjectPage(0);
  }, [query]);

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

        {projectsStatus === "loading" && projects.length === 0 ? (
          <p className="py-10 text-center text-sm" style={{ color: "var(--text-tertiary)" }}>Loading projects…</p>
        ) : projectsStatus === "error" && projects.length === 0 ? (
          <EmptyState
            icon={<AlertCircle size={24} />}
            headline="Can't load projects"
            description={toUserMessage(new AppError(projectsError ?? "server"))}
            action={api ? <Button variant="primary" onClick={() => void loadProjects(api)}>Retry</Button> : undefined}
          />
        ) : visibleProjects.length > 0 ? (
          <ul aria-label="Projects" className="grid list-none grid-cols-1 gap-3 p-0 sm:grid-cols-2 md:grid-cols-3">
            {pagedProjects.map((project) => {
              const summary = summaryProjects?.find((candidate) => candidate.id === project.slug);
              return (
                <li key={project.slug} className="min-w-0">
                  <ProjectCard
                    project={project}
                    summaryUpdatedAt={summary?.updatedAt}
                    onOpen={() => openProjectOverview(project.slug, project.name || project.slug)}
                  />
                </li>
              );
            })}
          </ul>
        ) : (
          <div className="rounded-xl border px-5 py-10 text-center" style={{ borderColor: "var(--border-subtle)", color: "var(--text-tertiary)" }}>
            {query ? "No projects match your search." : "Create your first project to get started."}
          </div>
        )}
        {visibleProjects.length > PROJECTS_PAGE_SIZE ? (
          <nav aria-label="Project pages" className="mt-4 flex items-center justify-end gap-2">
            <span className="mr-auto text-xs" style={{ color: "var(--text-tertiary)" }}>
              {pageStart + 1}–{Math.min(pageStart + PROJECTS_PAGE_SIZE, visibleProjects.length)} of {visibleProjects.length}
            </span>
            <Button
              variant="ghost"
              aria-label="Previous projects page"
              disabled={currentProjectPage === 0}
              onClick={() => setProjectPage((page) => Math.max(0, page - 1))}
            >
              Previous
            </Button>
            <Button
              variant="ghost"
              aria-label="Next projects page"
              disabled={currentProjectPage >= lastProjectPage}
              onClick={() => setProjectPage((page) => Math.min(lastProjectPage, page + 1))}
            >
              Next
            </Button>
          </nav>
        ) : null}
      </div>
    </main>
  );
}
