"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { BotIcon, CodeIcon, GitBranchIcon, PanelRightOpenIcon, PlayIcon, PlusIcon, RefreshCwIcon } from "lucide-react";
import { RuntimeSummarySchema, type PreviewSessionSummary } from "@matrix-os/contracts";
import { getGatewayUrl } from "@/lib/gateway";
import { getCodeEditorUrl } from "@/lib/feature-flags";

const GATEWAY_URL = getGatewayUrl();
const FETCH_TIMEOUT_MS = 10_000;
const TASK_RENDER_LIMIT = 80;
const PROJECT_RENDER_LIMIT = 100;

interface ProjectSummary {
  slug?: string;
  name?: string;
  localPath?: string;
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
  worktreeId?: string;
  pr?: number;
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
  pr?: number | { number?: number };
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

type WorkspaceAgent = "claude" | "codex" | "opencode" | "pi";

const WORKSPACE_AGENTS: WorkspaceAgent[] = ["codex", "claude", "opencode", "pi"];

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

async function fetchCodingAgentPreviews(projectSlug: string): Promise<PreviewSessionSummary[]> {
  const body = await fetchJson<unknown>(`/api/coding-agents/summary?projectId=${encodeURIComponent(projectSlug)}`);
  const summary = RuntimeSummarySchema.parse(body);
  const previewEnabled = summary.capabilities.some((capability) => capability.id === "codingAgentsPreview" && capability.enabled);
  return previewEnabled
    ? summary.previewSessions.items.filter((preview) => preview.projectId === projectSlug)
    : [];
}

const COUNT_FORMATTER = new Intl.NumberFormat("en-US");

function formatCount(value: number): string {
  return COUNT_FORMATTER.format(value);
}

function projectLabel(project: ProjectSummary): string {
  return project.name ?? project.slug ?? "Untitled";
}

function projectRepo(project: ProjectSummary): string {
  return project.github?.owner && project.github.repo ? `${project.github.owner}/${project.github.repo}` : "-";
}

function worktreePrNumber(worktree?: WorkspaceWorktree): number | undefined {
  const value = typeof worktree?.pr === "number" ? worktree.pr : worktree?.pr?.number;
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function previewOrigin(origin?: string): string {
  if (!origin) return "Preview unavailable";
  try {
    return new URL(origin).origin;
  } catch {
    return "Preview unavailable";
  }
}

function previewHref(preview: PreviewSessionSummary): string | undefined {
  if (preview.status !== "running" || !preview.origin) return undefined;
  try {
    const url = new URL(preview.origin);
    return url.protocol === "https:" ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

// react-doctor-disable-next-line react-doctor/prefer-useReducer, react-doctor/no-giant-component -- the 22 useState fields are mostly independent (separate form inputs, transient status messages, multiple server lists, and per-action in-flight flags) rather than one related cluster; collapsing them into a single reducer would not be a mechanical, behavior-identical change and would obscure the independent update sites. The component is a single cohesive workspace dashboard whose handlers all close over this shared state, so splitting it would require threading every setter through props with no behavior change.
export function WorkspaceApp({ initialProjectSlug }: WorkspaceAppProps) {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [selectedSlug, setSelectedSlug] = useState(initialProjectSlug ?? "");
  const [tasks, setTasks] = useState<WorkspaceTask[]>([]);
  const [sessions, setSessions] = useState<WorkspaceSession[]>([]);
  const [reviews, setReviews] = useState<WorkspaceReview[]>([]);
  const [worktrees, setWorktrees] = useState<WorkspaceWorktree[]>([]);
  const [previews, setPreviews] = useState<WorkspacePreview[]>([]);
  const [codingAgentPreviews, setCodingAgentPreviews] = useState<PreviewSessionSummary[]>([]);
  const [events, setEvents] = useState<WorkspaceEvent[]>([]);
  const [attachMessage, setAttachMessage] = useState("");
  const [sessionSearch, setSessionSearch] = useState("");
  const [newProjectUrl, setNewProjectUrl] = useState("");
  const [newProjectSlug, setNewProjectSlug] = useState("");
  const [newWorktreeBranch, setNewWorktreeBranch] = useState("");
  const [selectedWorktreeId, setSelectedWorktreeId] = useState("");
  const [selectedAgent, setSelectedAgent] = useState<WorkspaceAgent>("codex");
  const [agentPrompt, setAgentPrompt] = useState("");
  const [agentMessage, setAgentMessage] = useState("");
  const [worktreeMessage, setWorktreeMessage] = useState("");
  const [creatingProject, setCreatingProject] = useState(false);
  const [creatingWorktree, setCreatingWorktree] = useState(false);
  const [startingAgent, setStartingAgent] = useState(false);
  const [error, setError] = useState("");

  const selectedProject = projects.find((project) => project.slug === selectedSlug) ?? projects[0];
  const activeSlug = selectedProject?.slug ?? selectedSlug;
  const activeSlugRef = useRef(activeSlug);
  // react-doctor-disable-next-line react-hooks-js/refs -- intentional latest-value mirror of `activeSlug`, written in render and read synchronously inside async response guards (loadProjectDetail/createWorktree/startAgent) so stale responses from a previous project are dropped without re-creating those callbacks on every slug change. Moving the write into an effect would lag the mirror by one commit and could mis-attribute a response that resolves during the switch.
  activeSlugRef.current = activeSlug;

  // Reset per-project UI state when the active project changes, during render
  // (React's documented "adjust state on prop change" pattern) instead of in an
  // effect, so there is no intermediate stale commit between the two renders.
  // react-doctor-disable-next-line react-doctor/rerender-state-only-in-handlers -- `prevActiveSlug` IS read in render (the `activeSlug !== prevActiveSlug` guard below); the rule only inspects JSX. A ref cannot replace it: this is React's documented prev-prop pattern where the state update must trigger the corrective synchronous re-render that discards the in-progress render. A ref would not re-render and would break the reset.
  const [prevActiveSlug, setPrevActiveSlug] = useState(activeSlug);
  if (activeSlug !== prevActiveSlug) {
    setPrevActiveSlug(activeSlug);
    setSelectedWorktreeId("");
    setAgentMessage("");
    setWorktreeMessage("");
    setCreatingWorktree(false);
    setStartingAgent(false);
    setCodingAgentPreviews([]);
  }

  // Default the selected worktree to the first available one (and drop a
  // selection that no longer exists) whenever the worktree list changes. This
  // runs during render via a prev-value comparison so the controlled <select>
  // never commits an out-of-range value first.
  // react-doctor-disable-next-line react-doctor/rerender-state-only-in-handlers -- `prevWorktrees` IS read in render (the `worktrees !== prevWorktrees` guard below); the rule only inspects JSX. A ref cannot replace it: the state update must trigger the corrective synchronous re-render that re-derives `selectedWorktreeId`. A ref would not re-render and would leave a stale selection.
  const [prevWorktrees, setPrevWorktrees] = useState(worktrees);
  if (worktrees !== prevWorktrees) {
    setPrevWorktrees(worktrees);
    const firstWorktreeId = worktrees.find((worktree) => worktree.id)?.id ?? "";
    setSelectedWorktreeId((current) => {
      if (!firstWorktreeId) return "";
      if (!current || !worktrees.some((worktree) => worktree.id === current)) return firstWorktreeId;
      return current;
    });
  }

  // react-doctor-disable-next-line react-doctor/react-compiler-no-manual-memoization -- stable identity is consumed by a useEffect dependency array (the initial-load effect) and by createProject's callback dependency; removing useCallback would re-run the effect on unrelated re-renders.
  const loadProjects = useCallback(async () => {
    try {
      const data = await fetchJson<{ projects: ProjectSummary[] }>("/api/workspace/projects");
      setProjects(data.projects ?? []);
      if (!selectedSlug && data.projects?.[0]?.slug) {
        setSelectedSlug(data.projects[0].slug);
      }
      setError("");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Workspace request failed");
    }
  }, [selectedSlug]);

  // react-doctor-disable-next-line react-doctor/react-compiler-no-manual-memoization -- stable identity is consumed by a useEffect dependency array (the per-project detail-load effect); removing useCallback would re-run the effect on every render and refetch all project detail.
  const loadProjectDetail = useCallback(async (projectSlug: string) => {
    if (!projectSlug) return;
    try {
      const encodedSlug = encodeURIComponent(projectSlug);
      // react-doctor-disable-next-line react-doctor/async-defer-await -- the await must run before the `activeSlugRef.current !== projectSlug` staleness check below: that guard discards results from a superseded selection AFTER the fetch resolves, so the await cannot be deferred past it. The rule misses this because the ref is named `activeSlugRef`, not a bare guard identifier.
      const [taskData, sessionData, reviewData, worktreeData, previewData, eventData, codingPreviewData] = await Promise.all([
        fetchJson<{ tasks: WorkspaceTask[] }>(`/api/projects/${encodedSlug}/tasks?includeArchived=true&limit=100`),
        fetchJson<{ sessions: WorkspaceSession[] }>(`/api/sessions?projectSlug=${encodedSlug}&limit=100`),
        fetchJson<{ reviews: WorkspaceReview[] }>(`/api/reviews?projectSlug=${encodedSlug}&limit=20`),
        fetchJson<{ worktrees: WorkspaceWorktree[] }>(`/api/projects/${encodedSlug}/worktrees`),
        fetchJson<{ previews: WorkspacePreview[] }>(`/api/projects/${encodedSlug}/previews?limit=20`),
        fetchJson<{ events: WorkspaceEvent[] }>(`/api/workspace/events?projectSlug=${encodedSlug}&limit=20`),
        fetchCodingAgentPreviews(projectSlug).catch(() => {
          console.warn("Coding agent previews unavailable");
          return [];
        }),
      ]);
      if (activeSlugRef.current !== projectSlug) return;
      setTasks(taskData.tasks ?? []);
      setSessions(sessionData.sessions ?? []);
      setReviews(reviewData.reviews ?? []);
      setWorktrees(worktreeData.worktrees ?? []);
      setPreviews(previewData.previews ?? []);
      setCodingAgentPreviews(codingPreviewData);
      setEvents(eventData.events ?? []);
      setError("");
    } catch (err: unknown) {
      if (activeSlugRef.current !== projectSlug) return;
      setCodingAgentPreviews([]);
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

  const attachSession = async (sessionId: string) => {
    const data = await fetchJson<{ terminalSessionId?: string }>(`/api/sessions/${encodeURIComponent(sessionId)}/observe`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    setAttachMessage(data.terminalSessionId ? `Attached ${data.terminalSessionId}` : "Attached");
  };

  const takeoverSession = async (sessionId: string) => {
    const data = await fetchJson<{ terminalSessionId?: string }>(`/api/sessions/${encodeURIComponent(sessionId)}/takeover`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    setAttachMessage(data.terminalSessionId ? `Attached ${data.terminalSessionId}` : "Attached");
  };

  const duplicateSession = async (session: WorkspaceSession) => {
    await fetchJson<{ session?: WorkspaceSession }>("/api/sessions", {
      method: "POST",
      body: JSON.stringify({
        kind: session.agent ? "agent" : "shell",
        ...(session.agent ? { agent: session.agent } : {}),
        ...(session.projectSlug ? { projectSlug: session.projectSlug } : {}),
        ...(session.taskId ? { taskId: session.taskId } : {}),
        ...(session.worktreeId ? { worktreeId: session.worktreeId } : {}),
        ...(session.pr ? { pr: session.pr } : {}),
      }),
    });
    await loadProjectDetail(activeSlug);
  };

  const killSession = async (sessionId: string) => {
    await fetchJson<{ session?: WorkspaceSession }>(`/api/sessions/${encodeURIComponent(sessionId)}`, {
      method: "DELETE",
      body: JSON.stringify({}),
    });
    await loadProjectDetail(activeSlug);
  };

  const createProject = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const url = newProjectUrl.trim();
    const slug = newProjectSlug.trim();
    if (!url) {
      setError("Enter a GitHub repository URL");
      return;
    }

    setCreatingProject(true);
    // react-doctor-disable-next-line react-hooks-js/todo -- React Compiler cannot lower try/finally; the finally clause guarantees the in-flight flag resets regardless of outcome, which is the correct shape here.
    try {
      const data = await fetchJson<{ project?: ProjectSummary }>("/api/projects", {
        method: "POST",
        body: JSON.stringify({
          url,
          ...(slug ? { slug } : {}),
        }),
      });
      const createdSlug = data.project?.slug ?? slug;
      setNewProjectUrl("");
      setNewProjectSlug("");
      if (createdSlug) setSelectedSlug(createdSlug);
      await loadProjects();
      setError("");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Project import failed");
    } finally {
      setCreatingProject(false);
    }
  };

  const createWorktree = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!activeSlug) {
      setError("Select a project first");
      return;
    }
    const branch = newWorktreeBranch.trim();
    if (!branch) {
      setError("Enter a branch name");
      return;
    }

    const existingWorktree = worktrees.find((worktree) => worktree.id && worktree.currentBranch === branch);
    if (existingWorktree?.id) {
      setSelectedWorktreeId(existingWorktree.id);
      setNewWorktreeBranch("");
      setWorktreeMessage(`Using ${existingWorktree.id}`);
      setAgentMessage("");
      setError("");
      return;
    }

    setCreatingWorktree(true);
    // react-doctor-disable-next-line react-hooks-js/todo -- React Compiler cannot lower try/finally; the finally clause guarantees the in-flight flag resets regardless of outcome, which is the correct shape here.
    try {
      // react-doctor-disable-next-line react-doctor/async-defer-await -- the await must run before the `activeSlugRef.current !== activeSlug` staleness check below: that guard validates the request is still relevant AFTER the network round-trip, so the await cannot be deferred past it. The rule misses this because the ref is named `activeSlugRef`, not a bare guard identifier.
      const data = await fetchJson<{ worktree?: WorkspaceWorktree }>(`/api/projects/${encodeURIComponent(activeSlug)}/worktrees`, {
        method: "POST",
        body: JSON.stringify({ branch }),
      });
      if (activeSlugRef.current !== activeSlug) return;
      const createdWorktree = data.worktree;
      if (createdWorktree?.id) {
        setWorktrees((current) => [
          ...current.filter((worktree) => worktree.id !== createdWorktree.id),
          createdWorktree,
        ]);
        setSelectedWorktreeId(createdWorktree.id);
        setWorktreeMessage(`Created ${createdWorktree.id}`);
      } else {
        setWorktreeMessage("Created worktree");
        await loadProjectDetail(activeSlug);
      }
      setAgentMessage("");
      setNewWorktreeBranch("");
      setError("");
    } catch (err: unknown) {
      if (activeSlugRef.current === activeSlug) {
        setError(err instanceof Error ? err.message : "Worktree creation failed");
      }
    } finally {
      setCreatingWorktree(false);
    }
  };

  const startAgent = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!activeSlug) {
      setError("Select a project first");
      return;
    }
    const worktreeId = selectedWorktreeId.trim();
    const prompt = agentPrompt.trim();
    if (!worktreeId) {
      setError("Select a worktree");
      return;
    }
    if (!prompt) {
      setError("Enter an agent prompt");
      return;
    }

    setStartingAgent(true);
    // react-doctor-disable-next-line react-hooks-js/todo -- React Compiler cannot lower try/finally; the finally clause guarantees the in-flight flag resets regardless of outcome, which is the correct shape here.
    try {
      const selectedWorktree = worktrees.find((worktree) => worktree.id === worktreeId);
      const pr = worktreePrNumber(selectedWorktree);
      const data = await fetchJson<{ session?: WorkspaceSession }>("/api/sessions", {
        method: "POST",
        body: JSON.stringify({
          kind: "agent",
          agent: selectedAgent,
          projectSlug: activeSlug,
          worktreeId,
          ...(pr ? { pr } : {}),
          prompt,
          runtimePreference: "zellij",
        }),
      });
      if (activeSlugRef.current === activeSlug) {
        setAgentPrompt("");
        setAgentMessage(data.session?.id ? `Started ${data.session.id}` : "Started agent");
        await loadProjectDetail(activeSlug);
        setError("");
      }
    } catch (err: unknown) {
      if (activeSlugRef.current === activeSlug) {
        setError(err instanceof Error ? err.message : "Agent start failed");
      }
    } finally {
      setStartingAgent(false);
    }
  };

  const visibleProjects = projects.slice(0, PROJECT_RENDER_LIMIT);
  const visibleTasks = tasks.slice(0, TASK_RENDER_LIMIT);
  const normalizedSessionSearch = sessionSearch.trim().toLowerCase();
  const visibleSessions = sessions.filter((session) => {
    if (!normalizedSessionSearch) return true;
    return [session.id, session.projectSlug, session.taskId, session.agent, session.status]
      .filter((value): value is string => typeof value === "string")
      .some((value) => value.toLowerCase().includes(normalizedSessionSearch));
  });
  const ideFolder = selectedProject?.localPath ?? (activeSlug ? `/home/matrixos/home/projects/${activeSlug}` : "/home/matrixos/home");
  const ideHref = getCodeEditorUrl(ideFolder);

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
          <form onSubmit={createProject} className="mx-2 mb-3 space-y-2 rounded-md border border-border p-2">
            <input
              aria-label="GitHub repository URL"
              value={newProjectUrl}
              onChange={(event) => setNewProjectUrl(event.target.value)}
              placeholder="github.com/owner/repo"
              className="h-8 w-full rounded-md border border-border bg-background px-2 text-xs text-foreground"
            />
            <div className="flex gap-2">
              <input
                aria-label="Project slug"
                value={newProjectSlug}
                onChange={(event) => setNewProjectSlug(event.target.value)}
                placeholder="slug"
                className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-xs text-foreground"
              />
              <button
                type="submit"
                disabled={creatingProject}
                className="inline-flex h-8 items-center justify-center gap-1 rounded-md border border-border px-2 text-xs hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
              >
                <PlusIcon className="size-3.5" />
                {creatingProject ? "Adding" : "Add"}
              </button>
            </div>
          </form>
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
          {!selectedProject ? (
            <section data-testid="workspace-empty" className="flex min-h-[280px] items-center justify-center p-6">
              <div className="max-w-sm text-center">
                <CodeIcon className="mx-auto mb-3 size-8 text-muted-foreground" />
                <h2 className="text-sm font-semibold">No projects yet</h2>
                <p className="mt-1 text-xs text-muted-foreground">Add a GitHub repository from the Projects panel.</p>
              </div>
            </section>
          ) : (
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
          )}
        </main>

        <aside className="min-h-0 overflow-auto border-t border-border lg:border-l lg:border-t-0">
          <WorkspacePanel title="Sessions" icon={<PanelRightOpenIcon className="size-3.5" />}>
            <form onSubmit={startAgent} className="mb-3 space-y-2 rounded-md border border-border p-2">
              <div className="grid grid-cols-2 gap-2">
                <label className="block text-xs text-muted-foreground">
                  Agent
                  <select
                    aria-label="Agent"
                    value={selectedAgent}
                    onChange={(event) => setSelectedAgent(event.target.value as WorkspaceAgent)}
                    className="mt-1 h-8 w-full rounded-md border border-border bg-background px-2 text-xs text-foreground"
                  >
                    {WORKSPACE_AGENTS.map((agent) => (
                      <option key={agent} value={agent}>{agent}</option>
                    ))}
                  </select>
                </label>
                <label className="block text-xs text-muted-foreground">
                  Worktree
                  <select
                    aria-label="Agent worktree"
                    value={selectedWorktreeId}
                    onChange={(event) => setSelectedWorktreeId(event.target.value)}
                    disabled={worktrees.length === 0}
                    className="mt-1 h-8 w-full rounded-md border border-border bg-background px-2 text-xs text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {worktrees.length === 0 && <option value="">None</option>}
                    {worktrees.map((worktree) => (
                      <option key={worktree.id} value={worktree.id}>
                        {worktree.currentBranch ?? worktree.id}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <textarea
                aria-label="Agent prompt"
                value={agentPrompt}
                onChange={(event) => setAgentPrompt(event.target.value)}
                rows={3}
                className="w-full resize-none rounded-md border border-border bg-background px-2 py-1.5 text-xs text-foreground"
              />
              <button
                type="submit"
                disabled={startingAgent || !activeSlug || worktrees.length === 0}
                className="inline-flex h-8 w-full items-center justify-center gap-1 rounded-md border border-border px-2 text-xs hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
              >
                <PlayIcon className="size-3.5" />
                {startingAgent ? "Starting" : "Start agent"}
              </button>
            </form>
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
            {agentMessage && <p className="pt-2 text-xs text-muted-foreground">{agentMessage}</p>}
          </WorkspacePanel>

          <WorkspacePanel title="Worktrees" icon={<GitBranchIcon className="size-3.5" />}>
            <form onSubmit={createWorktree} className="mb-2 flex gap-2">
              <input
                aria-label="New worktree branch"
                value={newWorktreeBranch}
                onChange={(event) => setNewWorktreeBranch(event.target.value)}
                placeholder="feature/name"
                className="h-8 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-xs text-foreground"
              />
              <button
                type="submit"
                disabled={creatingWorktree || !activeSlug}
                className="inline-flex h-8 items-center justify-center gap-1 rounded-md border border-border px-2 text-xs hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
              >
                <GitBranchIcon className="size-3.5" />
                {creatingWorktree ? "Creating" : "Create worktree"}
              </button>
            </form>
            {worktreeMessage && <p className="pb-2 text-xs text-muted-foreground">{worktreeMessage}</p>}
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
            {codingAgentPreviews.map((preview) => (
              <CodingAgentPreviewRow key={preview.id} preview={preview} />
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

function CodingAgentPreviewRow({ preview }: { preview: PreviewSessionSummary }) {
  const href = previewHref(preview);
  const content = (
    <>
      <span className="font-medium">{preview.label}</span>
      <span className="block text-muted-foreground">{previewOrigin(preview.origin)}</span>
      <span className="block text-muted-foreground">{preview.status}</span>
    </>
  );

  if (href) {
    return (
      <a href={href} target="_blank" rel="noreferrer" className="block py-2 text-xs hover:underline">
        {content}
      </a>
    );
  }

  return <div className="py-2 text-xs">{content}</div>;
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
