"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { BotIcon, CodeIcon, GitBranchIcon, PanelRightOpenIcon, PlayIcon, RefreshCwIcon } from "lucide-react";
import { getGatewayUrl } from "@/lib/gateway";

const GATEWAY_URL = getGatewayUrl();
const FETCH_TIMEOUT_MS = 10_000;
const TASK_RENDER_LIMIT = 80;
const PROJECT_RENDER_LIMIT = 100;

interface ProjectSummary {
  slug?: string;
  name?: string;
  github?: { owner?: string; repo?: string };
}

interface WorkspaceTask {
  id?: string;
  title?: string;
  status?: string;
  priority?: string;
}

interface WorkspaceSession {
  id?: string;
  status?: string;
  projectSlug?: string;
  taskId?: string;
  agent?: string;
  runtime?: { status?: string };
  nativeAttachCommand?: string[];
}

interface WorkspaceReview {
  id?: string;
  status?: string;
  round?: number;
}

interface WorkspaceWorktree {
  id?: string;
  currentBranch?: string;
  dirtyState?: string;
}

interface WorkspacePreview {
  id?: string;
  label?: string;
  url?: string;
  lastStatus?: string;
}

interface WorkspaceEvent {
  id?: string;
  type?: string;
  createdAt?: string;
}

interface WorkspaceAppProps {
  initialProjectSlug?: string;
}

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${GATEWAY_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error("Workspace request failed");
  }
  return await response.json() as T;
}

function formatCount(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

function projectLabel(project: ProjectSummary): string {
  return project.name ?? project.slug ?? "Untitled";
}

function projectRepo(project: ProjectSummary): string {
  return project.github?.owner && project.github.repo ? `${project.github.owner}/${project.github.repo}` : "-";
}

export function WorkspaceApp({ initialProjectSlug }: WorkspaceAppProps) {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [selectedSlug, setSelectedSlug] = useState(initialProjectSlug ?? "");
  const [tasks, setTasks] = useState<WorkspaceTask[]>([]);
  const [sessions, setSessions] = useState<WorkspaceSession[]>([]);
  const [reviews, setReviews] = useState<WorkspaceReview[]>([]);
  const [worktrees, setWorktrees] = useState<WorkspaceWorktree[]>([]);
  const [previews, setPreviews] = useState<WorkspacePreview[]>([]);
  const [events, setEvents] = useState<WorkspaceEvent[]>([]);
  const [attachMessage, setAttachMessage] = useState("");
  const [sessionSearch, setSessionSearch] = useState("");
  const [error, setError] = useState("");

  const selectedProject = useMemo(
    () => projects.find((project) => project.slug === selectedSlug) ?? projects[0],
    [projects, selectedSlug],
  );
  const activeSlug = selectedProject?.slug ?? selectedSlug;

  const loadProjects = useCallback(async () => {
    try {
      const data = await fetchJson<{ projects: ProjectSummary[] }>("/api/projects");
      setProjects(data.projects ?? []);
      if (!selectedSlug && data.projects?.[0]?.slug) {
        setSelectedSlug(data.projects[0].slug);
      }
      setError("");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Workspace request failed");
    }
  }, [selectedSlug]);

  const loadProjectDetail = useCallback(async (projectSlug: string) => {
    if (!projectSlug) return;
    try {
      const encodedSlug = encodeURIComponent(projectSlug);
      const [taskData, sessionData, reviewData, worktreeData, previewData, eventData] = await Promise.all([
        fetchJson<{ tasks: WorkspaceTask[] }>(`/api/projects/${encodedSlug}/tasks?includeArchived=true&limit=100`),
        fetchJson<{ sessions: WorkspaceSession[] }>(`/api/sessions?projectSlug=${encodedSlug}&limit=100`),
        fetchJson<{ reviews: WorkspaceReview[] }>(`/api/reviews?projectSlug=${encodedSlug}&limit=20`),
        fetchJson<{ worktrees: WorkspaceWorktree[] }>(`/api/projects/${encodedSlug}/worktrees`),
        fetchJson<{ previews: WorkspacePreview[] }>(`/api/projects/${encodedSlug}/previews?limit=20`),
        fetchJson<{ events: WorkspaceEvent[] }>(`/api/workspace/events?projectSlug=${encodedSlug}&limit=20`),
      ]);
      setTasks(taskData.tasks ?? []);
      setSessions(sessionData.sessions ?? []);
      setReviews(reviewData.reviews ?? []);
      setWorktrees(worktreeData.worktrees ?? []);
      setPreviews(previewData.previews ?? []);
      setEvents(eventData.events ?? []);
      setError("");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Workspace request failed");
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadProjects(), 0);
    return () => window.clearTimeout(timer);
  }, [loadProjects]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadProjectDetail(activeSlug), 0);
    return () => window.clearTimeout(timer);
  }, [activeSlug, loadProjectDetail]);

  const attachSession = useCallback(async (sessionId: string) => {
    const data = await fetchJson<{ terminalSessionId?: string }>(`/api/sessions/${encodeURIComponent(sessionId)}/observe`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    setAttachMessage(data.terminalSessionId ? `Attached ${data.terminalSessionId}` : "Attached");
  }, []);

  const takeoverSession = useCallback(async (sessionId: string) => {
    const data = await fetchJson<{ terminalSessionId?: string }>(`/api/sessions/${encodeURIComponent(sessionId)}/takeover`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    setAttachMessage(data.terminalSessionId ? `Attached ${data.terminalSessionId}` : "Attached");
  }, []);

  const duplicateSession = useCallback(async (session: WorkspaceSession) => {
    await fetchJson<{ session?: WorkspaceSession }>("/api/sessions", {
      method: "POST",
      body: JSON.stringify({
        kind: session.agent ? "agent" : "shell",
        ...(session.agent ? { agent: session.agent } : {}),
        ...(session.projectSlug ? { projectSlug: session.projectSlug } : {}),
        ...(session.taskId ? { taskId: session.taskId } : {}),
      }),
    });
    await loadProjectDetail(activeSlug);
  }, [activeSlug, loadProjectDetail]);

  const killSession = useCallback(async (sessionId: string) => {
    await fetchJson<{ session?: WorkspaceSession }>(`/api/sessions/${encodeURIComponent(sessionId)}`, {
      method: "DELETE",
      body: JSON.stringify({}),
    });
    await loadProjectDetail(activeSlug);
  }, [activeSlug, loadProjectDetail]);

  const visibleProjects = projects.slice(0, PROJECT_RENDER_LIMIT);
  const visibleTasks = tasks.slice(0, TASK_RENDER_LIMIT);
  const normalizedSessionSearch = sessionSearch.trim().toLowerCase();
  const visibleSessions = sessions.filter((session) => {
    if (!normalizedSessionSearch) return true;
    return [session.id, session.projectSlug, session.taskId, session.agent, session.status]
      .filter((value): value is string => typeof value === "string")
      .some((value) => value.toLowerCase().includes(normalizedSessionSearch));
  });
  const ideFolder = activeSlug ? `/home/matrixos/home/projects/${activeSlug}` : "/home/matrixos/home";
  const ideHref = `https://code.matrix-os.com/?folder=${encodeURIComponent(ideFolder)}`;

  return (
    <div
      data-testid="workspace-shell"
      data-project-count={projects.length}
      className="flex h-full min-h-0 flex-col bg-background text-foreground"
    >
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <h1 className="text-base font-semibold">Cloud Workspace</h1>
          <p className="text-xs text-muted-foreground">
            {formatCount(projects.length)} projects · {formatCount(tasks.length)} tasks · {formatCount(sessions.length)} sessions
          </p>
        </div>
        <div className="flex items-center gap-2">
          <a
            href={ideHref}
            data-folder={ideFolder}
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-8 items-center gap-2 rounded-md border border-border px-3 text-xs hover:bg-accent"
          >
            <CodeIcon className="size-3.5" />
            Open IDE
          </a>
          <button
            type="button"
            onClick={() => void loadProjectDetail(activeSlug)}
            className="inline-flex size-8 items-center justify-center rounded-md border border-border hover:bg-accent"
            aria-label="Refresh workspace"
          >
            <RefreshCwIcon className="size-3.5" />
          </button>
        </div>
      </header>

      {error && (
        <div className="border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-xs text-destructive">
          {error}
        </div>
      )}

      <div
        data-testid="workspace-layout"
        className="grid min-h-0 flex-1 grid-cols-1 overflow-hidden lg:grid-cols-[240px_1fr_320px]"
      >
        <aside className="min-h-0 overflow-auto border-b border-border lg:border-b-0 lg:border-r">
          <div className="px-3 py-2 text-xs font-medium text-muted-foreground">Projects</div>
          <div className="space-y-1 px-2 pb-3">
            {visibleProjects.map((project) => (
              <button
                key={project.slug}
                type="button"
                onClick={() => setSelectedSlug(project.slug ?? "")}
                className={`w-full rounded-md px-2 py-2 text-left text-sm ${project.slug === activeSlug ? "bg-accent" : "hover:bg-accent/60"}`}
              >
                <span className="block truncate font-medium">{projectLabel(project)}</span>
                <span className="block truncate text-xs text-muted-foreground">{projectRepo(project)}</span>
              </button>
            ))}
          </div>
        </aside>

        <main className="min-h-0 overflow-auto">
          <section className="border-b border-border px-4 py-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="text-sm font-semibold">{projectLabel(selectedProject ?? {})}</h2>
                <p className="text-xs text-muted-foreground">
                  Showing {formatCount(visibleTasks.length)} of {formatCount(tasks.length)} tasks
                </p>
              </div>
              <span className="text-xs text-muted-foreground">{formatCount(tasks.length)} tasks</span>
            </div>
          </section>
          <section
            data-testid="workspace-task-grid"
            className="grid grid-cols-1 gap-px bg-border md:grid-cols-2 xl:grid-cols-3"
          >
            {visibleTasks.map((task) => (
              <article key={task.id} className="min-h-[96px] bg-background p-3">
                <div className="flex items-start justify-between gap-2">
                  <h3 className="line-clamp-2 text-sm font-medium">{task.title ?? task.id}</h3>
                  <span className="shrink-0 rounded border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground">
                    {task.priority ?? "normal"}
                  </span>
                </div>
                <p className="mt-3 text-xs text-muted-foreground">{task.status ?? "todo"}</p>
              </article>
            ))}
          </section>
        </main>

        <aside className="min-h-0 overflow-auto border-t border-border lg:border-l lg:border-t-0">
          <WorkspacePanel title="Sessions" icon={<PanelRightOpenIcon className="size-3.5" />}>
            <label className="mb-2 block text-xs text-muted-foreground">
              Search sessions
              <input
                aria-label="Search sessions"
                value={sessionSearch}
                onChange={(event) => setSessionSearch(event.target.value)}
                className="mt-1 h-8 w-full rounded-md border border-border bg-background px-2 text-xs text-foreground"
              />
            </label>
            {visibleSessions.map((session) => (
              <div key={session.id} className="py-2 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate font-medium">{session.id}</div>
                    <div className="text-muted-foreground">{session.status ?? "unknown"} · {session.agent ?? "shell"}</div>
                    <div className="text-muted-foreground">{session.runtime?.status ?? session.status ?? "unknown"} health</div>
                  </div>
                </div>
                {session.nativeAttachCommand && (
                  <code className="mt-2 block truncate rounded bg-muted px-2 py-1 text-[11px] text-muted-foreground">
                    {session.nativeAttachCommand.join(" ")}
                  </code>
                )}
                {session.id && (
                  <div className="mt-2 grid grid-cols-2 gap-1">
                    <SessionButton label="Attach" sessionId={session.id} onClick={() => void attachSession(session.id!)} />
                    <SessionButton label="Take over" sessionId={session.id} onClick={() => void takeoverSession(session.id!)} />
                    <SessionButton label="Duplicate" sessionId={session.id} onClick={() => void duplicateSession(session)} />
                    <SessionButton label="Kill" sessionId={session.id} onClick={() => void killSession(session.id!)} />
                  </div>
                )}
              </div>
            ))}
            {attachMessage && <p className="pt-2 text-xs text-muted-foreground">{attachMessage}</p>}
          </WorkspacePanel>

          <WorkspacePanel title="Worktrees" icon={<GitBranchIcon className="size-3.5" />}>
            {worktrees.map((worktree) => (
              <div key={worktree.id} className="py-2 text-xs">
                <div className="font-medium">{worktree.currentBranch ?? worktree.id}</div>
                <div className="text-muted-foreground">{worktree.dirtyState ?? "unknown"}</div>
              </div>
            ))}
          </WorkspacePanel>

          <WorkspacePanel title="Reviews" icon={<BotIcon className="size-3.5" />}>
            {reviews.map((review) => (
              <div key={review.id} className="py-2 text-xs">
                <div className="font-medium">{review.id}</div>
                <div className="text-muted-foreground">{review.status ?? "unknown"} · Round {review.round ?? 0}</div>
              </div>
            ))}
          </WorkspacePanel>

          <WorkspacePanel title="Previews">
            {previews.map((preview) => (
              <a
                key={preview.id}
                href={preview.url}
                target="_blank"
                rel="noreferrer"
                className="block py-2 text-xs hover:underline"
              >
                <span className="font-medium">{preview.label ?? preview.url}</span>
                <span className="block text-muted-foreground">{preview.lastStatus ?? "unknown"}</span>
              </a>
            ))}
          </WorkspacePanel>

          <WorkspacePanel title="Activity">
            {events.map((event) => (
              <div key={event.id} className="py-2 text-xs">
                <div className="font-medium">{event.type}</div>
                <div className="text-muted-foreground">{event.createdAt ?? ""}</div>
              </div>
            ))}
          </WorkspacePanel>
        </aside>
      </div>
    </div>
  );
}

function SessionButton({
  label,
  sessionId,
  onClick,
}: {
  label: string;
  sessionId: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={`${label} ${sessionId}`}
      onClick={onClick}
      className="inline-flex h-7 items-center justify-center gap-1 rounded border border-border px-2 hover:bg-accent"
    >
      <PlayIcon className="size-3" />
      {label}
    </button>
  );
}

function WorkspacePanel({
  title,
  icon,
  children,
}: {
  title: string;
  icon?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="border-b border-border px-4 py-3">
      <h2 className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase text-muted-foreground">
        {icon}
        {title}
      </h2>
      <div className="divide-y divide-border">{children}</div>
    </section>
  );
}
