import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { ChevronsLeftIcon, PlusIcon, RefreshCwIcon, SearchIcon } from "lucide-react";

import { getGatewayUrl } from "@/lib/gateway";
import { NewSessionMenu } from "./NewSessionMenu";
import { ShellCloseConfirmation } from "./ShellCloseConfirmation";
import { useTerminalAppContext } from "./TerminalAppContext";
import { ThemePickerButton } from "./TerminalThemePicker";
import { isCanonicalShellSessionId } from "./terminal-session-id";
import {
  DEFAULT_CWD,
  formatCwd,
  getFirstPaneId,
  getPaneSessionId,
  getSessionIds,
  hasPaneId,
} from "./terminal-layout";
import {
  parseTerminalAgentStatuses,
  terminalAgentVisibleInstallCommand,
  type TerminalAgentId,
  type TerminalAgentOption,
} from "./terminal-agent-options";
import {
  applyShellRefreshFailure,
  applyShellRefreshSilentFailure,
  applyShellRefreshSuccess,
  applyShellUiStatePatch,
  rollbackShellUiStatePatch,
  shellSessionsEqual,
  snapshotShellUiStatePatch,
  type ShellRefreshState,
  type ShellSessionSummary,
  type ShellUiStatePatch,
} from "./terminal-session-state";
import {
  CollapsedSessionsRail,
  ShellSessionGroup,
  filterTreeNodes,
  formatShellDisplayName,
  updateNode,
  type ProjectInfo,
  type TreeNode,
  type WorkspaceSessionSummary,
} from "./TerminalSidebarItems";

const SHELL_NEW_BUTTON_BASE_STYLE: CSSProperties = {
  height: 28,
  padding: "0 10px",
  borderRadius: 6,
  border: "1px solid transparent",
  background: "var(--primary)",
  color: "var(--primary-foreground)",
  fontSize: 12,
  fontWeight: 600,
  whiteSpace: "nowrap",
};

const SHELLS_REFRESH_INTERVAL_MS = 5_000;
const SHELL_SESSION_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,30}$/;
export const DEFAULT_TERMINAL_SIDEBAR_WIDTH = 392;
const MIN_TERMINAL_SIDEBAR_WIDTH = 280;
const MAX_TERMINAL_SIDEBAR_WIDTH = 560;
const TERMINAL_SIDEBAR_TRANSITION = "opacity 140ms ease, transform 180ms ease";
const SHELL_STATUS_DOT_CSS = `
@keyframes terminal-session-status-pulse {
  0%, 100% { box-shadow: 0 0 0 4px rgba(95, 184, 95, 0.24); }
  50% { box-shadow: 0 0 0 6px rgba(95, 184, 95, 0.10); }
}
@keyframes terminal-refresh-spin {
  to { transform: rotate(360deg); }
}
.terminal-session-status-dot--running {
  animation: terminal-session-status-pulse 1.35s ease-in-out infinite;
}
.terminal-refresh-icon--loading {
  animation: terminal-refresh-spin 0.9s linear infinite;
}
@media (prefers-reduced-motion: reduce) {
  .terminal-session-status-dot--running,
  .terminal-refresh-icon--loading {
    animation: none;
  }
}
`;

function clampTerminalSidebarWidth(width: number): number {
  return Math.min(MAX_TERMINAL_SIDEBAR_WIDTH, Math.max(MIN_TERMINAL_SIDEBAR_WIDTH, Math.round(width)));
}
type SidebarTab = "projects" | "shells" | "sessions" | "files";
type NewSessionMenuAnchor = "drawer" | "rail";
type CloseConfirmationRequest = {
  shell: ShellSessionSummary;
  anchorElement: HTMLElement;
  returnFocusElement: HTMLButtonElement;
};

function workspaceSessionsEqual(left: WorkspaceSessionSummary[], right: WorkspaceSessionSummary[]): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort((a, b) => a.id.localeCompare(b.id));
  const sortedRight = [...right].sort((a, b) => a.id.localeCompare(b.id));
  return sortedLeft.every((session, index) => {
    const next = sortedRight[index];
    return (
      next !== undefined &&
      session.id === next.id &&
      session.kind === next.kind &&
      session.projectSlug === next.projectSlug &&
      session.taskId === next.taskId &&
      session.worktreeId === next.worktreeId &&
      session.pr === next.pr &&
      session.agent === next.agent &&
      session.runtime?.status === next.runtime?.status &&
      session.status === next.status &&
      session.transcriptPath === next.transcriptPath &&
      (session.nativeAttachCommand ?? []).join("\u0000") === (next.nativeAttachCommand ?? []).join("\u0000")
    );
  });
}

// react-doctor-disable-next-line react-doctor/no-giant-component, react-doctor/prefer-useReducer -- no-giant-component: cohesive core terminal sidebar component; extraction tracked separately. prefer-useReducer: the 16 useState fields are several independent clusters, not one related cluster: projects/shells/sessions/files each carry their own data+loading+error triplet with separate fetch lifecycles, plus orthogonal tab/filter/rootPath/tree/agent-status UI state; collapsing them into one reducer would obscure the independent update sites and would not be a mechanical, behavior-identical change.
export function LocalTerminalSidebar() {
  const ctx = useTerminalAppContext();
  const [tab, setTab] = useState<SidebarTab>("shells");
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [shells, setShells] = useState<ShellSessionSummary[]>([]);
  const [shellsAuthoritative, setShellsAuthoritative] = useState(false);
  const [shellsStale, setShellsStale] = useState(false);
  const [shellsLoading, setShellsLoading] = useState(false);
  const [shellsError, setShellsError] = useState<string | null>(null);
  const shellRefreshStateRef = useRef<ShellRefreshState>({
    shells: [],
    authoritative: false,
    stale: false,
    error: null,
  });
  // react-doctor-disable-next-line react-doctor/react-compiler-no-manual-memoization -- stable identity for `fetchShells` and shell-tab refresh effect dependencies in compiled and test/runtime surfaces.
  const commitShellRefreshState = useCallback((nextState: ShellRefreshState) => {
    shellRefreshStateRef.current = nextState;
    setShells(nextState.shells);
    setShellsAuthoritative(nextState.authoritative);
    setShellsStale(nextState.stale);
    setShellsError(nextState.error);
  }, []);
  useEffect(() => {
    shellRefreshStateRef.current = {
      shells,
      authoritative: shellsAuthoritative,
      stale: shellsStale,
      error: shellsError,
    };
  }, [shells, shellsAuthoritative, shellsError, shellsStale]);
  const creatingShellRef = useRef(false);
  const reorderSaveCountRef = useRef(0);
  const [creatingShell, setCreatingShell] = useState(false);
  const deletingShellsRef = useRef<Set<string> | null>(null);
  if (deletingShellsRef.current === null) deletingShellsRef.current = new Set();
  const [deletingShellNames, setDeletingShellNames] = useState<string[]>([]);
  const [closeConfirmationRequest, setCloseConfirmationRequest] = useState<CloseConfirmationRequest | null>(null);
  const pendingDeleteFocusRef = useRef<{ deletedName: string; targetName: string | null } | null>(null);
  const refreshSessionsButtonRef = useRef<HTMLButtonElement>(null);
  const sessionsScrollRef = useRef<HTMLDivElement>(null);
  const [newSessionMenuAnchor, setNewSessionMenuAnchor] = useState<NewSessionMenuAnchor | null>(null);
  const [backgroundSessionsExpanded, setBackgroundSessionsExpanded] = useState(true);
  const [draggingShellName, setDraggingShellName] = useState<string | null>(null);
  const [dragOverShellName, setDragOverShellName] = useState<string | null>(null);
  const [draggingShellPlacement, setDraggingShellPlacement] = useState<"active" | "background" | null>(null);
  const [sessions, setSessions] = useState<WorkspaceSessionSummary[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  const [agentStatuses, setAgentStatuses] = useState<Record<TerminalAgentId, boolean> | null>(null);
  const [rootPath, setRootPath] = useState("projects");
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [filter, setFilter] = useState("");

  const selectSidebarTab = (nextTab: SidebarTab) => {
    setTab(nextTab);
    setFilter("");
  };

  // react-doctor-disable-next-line react-doctor/react-compiler-no-manual-memoization -- stable identity for effect dep: `fetchProjects` is in the dependency array of the projects-tab useEffect below.
  const fetchProjects = useCallback(async () => {
    setProjectsLoading(true);
    setProjectsError(null);
    // react-doctor-disable-next-line react-hooks-js/todo -- React Compiler cannot lower the try/finally below into memoized form; the async load is correct as written
    try {
      const res = await fetch(`${getGatewayUrl()}/api/projects?root=projects`, {
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        setProjectsError("Failed to load projects");
        setProjects([]);
        return;
      }
      const data = (await res.json()) as { projects?: ProjectInfo[] };
      setProjects(Array.isArray(data.projects) ? data.projects : []);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn("Failed to load projects:", msg);
      setProjectsError("Could not reach gateway");
      setProjects([]);
    } finally {
      setProjectsLoading(false);
    }
  }, []);

  useEffect(() => {
    // react-doctor-disable-next-line react-hooks-js/set-state-in-effect, react-doctor/no-event-handler -- async network load of the projects list when the Projects tab becomes active; `tab` is live derived state that can change from many sources (restore, programmatic nav, deep link), not a single DOM click handler, so the fetch belongs in the effect and cannot be hoisted to one parent handler
    if (tab === "projects") void fetchProjects();
  }, [tab, fetchProjects]);

  // react-doctor-disable-next-line react-doctor/react-compiler-no-manual-memoization -- stable identity for mount-time agent status loading and explicit refresh from the new-session menu lifecycle.
  const fetchAgentStatuses = useCallback(async () => {
    try {
      const res = await fetch(`${getGatewayUrl()}/api/agents`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        console.warn(`Failed to load terminal agent status: ${res.status}`);
        return;
      }
      const parsed = parseTerminalAgentStatuses(await res.json());
      if (parsed.length === 0) return;
      setAgentStatuses(Object.fromEntries(
        parsed.map((agent) => [agent.id, agent.installed]),
      ) as Record<TerminalAgentId, boolean>);
    } catch (err: unknown) {
      console.warn("Failed to load terminal agent status:", err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    // react-doctor-disable-next-line react-hooks-js/set-state-in-effect, react-doctor/no-fetch-in-effect -- owner-scoped local gateway status probe; it is timeout-guarded and falls back to the Paper default menu state if unavailable.
    void fetchAgentStatuses();
  }, [fetchAgentStatuses]);

  // react-doctor-disable-next-line react-doctor/react-compiler-no-manual-memoization -- stable identity for effect dep: `fetchShells` is in the dependency array of the shells-tab load useEffect below and command handlers.
  const fetchShells = useCallback(async (options: { silent?: boolean; signal?: AbortSignal; preserveOrderDuringReorder?: boolean } = {}) => {
    const silent = options.silent === true;
    if (!silent) setShellsLoading(true);
    if (!silent) setShellsError(null);
    // react-doctor-disable-next-line react-hooks-js/todo -- React Compiler cannot lower the try/finally below into memoized form; the async load is correct as written
    try {
      const res = await fetch(`${getGatewayUrl()}/api/terminal/sessions`, {
        signal: options.signal ?? AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        if (silent) {
          commitShellRefreshState(applyShellRefreshSilentFailure(shellRefreshStateRef.current));
        }
        if (!silent) {
          commitShellRefreshState(applyShellRefreshFailure(
            shellRefreshStateRef.current,
            "Failed to load shells",
          ));
        }
        return;
      }
      if (options.preserveOrderDuringReorder === true && reorderSaveCountRef.current > 0) {
        return;
      }
      const data = (await res.json()) as { sessions?: ShellSessionSummary[] };
      const hasSessionList = Array.isArray(data.sessions);
      const nextShells = hasSessionList ? data.sessions! : [];
      commitShellRefreshState(applyShellRefreshSuccess(
        shellRefreshStateRef.current,
        nextShells,
        hasSessionList,
      ));
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      if (silent) {
        commitShellRefreshState(applyShellRefreshSilentFailure(shellRefreshStateRef.current));
        return;
      }
      console.warn("Failed to load shell sessions:", err instanceof Error ? err.message : err);
      commitShellRefreshState(applyShellRefreshFailure(
        shellRefreshStateRef.current,
        "Could not reach gateway",
      ));
    } finally {
      if (!silent) setShellsLoading(false);
    }
  }, [commitShellRefreshState]);

  useEffect(() => {
    if (tab !== "shells") return;
    const controller = new AbortController();
    // react-doctor-disable-next-line react-hooks-js/set-state-in-effect, react-doctor/no-event-handler -- async network load of the shell-session list when the Shells tab becomes active; `tab` is live derived state that can change from many sources (restore, programmatic nav, deep link), not a single DOM click handler, so the fetch belongs in the effect and cannot be hoisted to one parent handler
    void fetchShells({ signal: controller.signal });
    const refreshTimer = window.setInterval(() => {
      void fetchShells({ silent: true, signal: controller.signal, preserveOrderDuringReorder: true });
    }, SHELLS_REFRESH_INTERVAL_MS);
    return () => {
      controller.abort();
      window.clearInterval(refreshTimer);
    };
  }, [fetchShells, tab]);

  // react-doctor-disable-next-line react-doctor/react-compiler-no-manual-memoization -- stable identity for effect dep: `fetchSessions` is in the dependency array of the sessions-tab useEffect below.
  const fetchSessions = useCallback(async () => {
    setSessionsLoading(true);
    setSessionsError(null);
    // react-doctor-disable-next-line react-hooks-js/todo -- React Compiler cannot lower the try/finally below into memoized form; the async load is correct as written
    try {
      const res = await fetch(`${getGatewayUrl()}/api/sessions?limit=100`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        setSessionsError("Failed to load sessions");
        setSessions([]);
        return;
      }
      const data = (await res.json()) as { sessions?: WorkspaceSessionSummary[] };
      const nextSessions = Array.isArray(data.sessions)
        ? data.sessions.filter((session) => typeof session.id === "string" && session.id.length > 0)
        : [];
      setSessions((prev) => workspaceSessionsEqual(prev, nextSessions) ? prev : nextSessions);
    } catch (err: unknown) {
      console.warn("Failed to load workspace sessions:", err instanceof Error ? err.message : err);
      setSessionsError("Could not reach gateway");
      setSessions([]);
    } finally {
      setSessionsLoading(false);
    }
  }, []);

  useEffect(() => {
    // react-doctor-disable-next-line react-hooks-js/set-state-in-effect, react-doctor/no-event-handler -- async network load of the workspace-session list when the Sessions tab becomes active; `tab` is live derived state that can change from many sources (restore, programmatic nav, deep link), not a single DOM click handler, so the fetch belongs in the effect and cannot be hoisted to one parent handler
    if (tab === "sessions") void fetchSessions();
  }, [fetchSessions, tab]);

  // react-doctor-disable-next-line react-doctor/react-compiler-no-manual-memoization -- stable identity for effect dep: `fetchDir` is in the dependency array of the files-tab useEffect below.
  const fetchDir = useCallback(async (path: string) => {
    try {
      const res = await fetch(`${getGatewayUrl()}/api/files/tree?path=${encodeURIComponent(path)}`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return [];
      return res.json();
    } catch (err: unknown) {
      console.warn("Failed to load terminal directory tree:", err instanceof Error ? err.message : err);
      return [];
    }
  }, []);

  useEffect(() => {
    if (tab !== "files") return;
    fetchDir(rootPath).then((entries: TreeNode[]) => setTree(entries.map(e => ({ ...e, path: `${rootPath}/${e.name}` }))));
  }, [rootPath, fetchDir, tab]);

  const toggleExpand = async (node: TreeNode) => {
    if (node.type !== "directory") return;
    if (node.expanded) { setTree(prev => updateNode(prev, node.path, { expanded: false })); return; }
    const children = await fetchDir(node.path);
    setTree(prev => updateNode(prev, node.path, { expanded: true, children: children.map((c: TreeNode) => ({ ...c, path: `${node.path}/${c.name}` })) }));
  };

  const isAtRoot = !rootPath || rootPath === ".";
  const normalizedFilter = filter.trim().toLowerCase();
  const filteredProjects = normalizedFilter
    ? projects.filter((p) => p.name.toLowerCase().includes(normalizedFilter))
    : projects;
  const filteredShells = normalizedFilter
    ? shells.filter((shell) => [
      shell.name,
      shell.status,
      shell.tabs?.map((shellTab) => shellTab.name).join(" "),
    ].filter(Boolean).join(" ").toLowerCase().includes(normalizedFilter))
    : shells;
  const filteredSessions = normalizedFilter
    ? sessions.filter((session) => [
      session.id,
      session.projectSlug,
      session.taskId,
      session.worktreeId,
      session.agent,
      session.runtime?.status,
      session.status,
      session.transcriptPath,
    ].filter(Boolean).join(" ").toLowerCase().includes(normalizedFilter))
    : sessions;
  const filteredTree = normalizedFilter ? filterTreeNodes(tree, normalizedFilter) : tree;

  const createManagedShell = async () => {
    if (creatingShellRef.current) return;
    setNewSessionMenuAnchor(null);
    creatingShellRef.current = true;
    setCreatingShell(true);
    setShellsError(null);
    // react-doctor-disable-next-line react-hooks-js/todo -- React Compiler cannot lower the try/finally below into memoized form; the async create flow is correct as written
    try {
      const name = await ctx.createShellSessionTab("Shell", ctx.sidebarSelectedPath ?? DEFAULT_CWD);
      if (name) {
        await fetchShells();
      } else {
        setShellsError("Failed to create shell");
      }
    } catch (err: unknown) {
      console.warn("Failed to create shell session:", err instanceof Error ? err.message : err);
      setShellsError("Could not create shell");
    } finally {
      creatingShellRef.current = false;
      setCreatingShell(false);
    }
  };

  const deleteManagedShell = async (name: string) => {
    if (deletingShellsRef.current!.has(name)) return;
    deletingShellsRef.current!.add(name);
    setDeletingShellNames(Array.from(deletingShellsRef.current!));
    setShellsError(null);
    const previousShells = shells;
    const deletedShell = previousShells.find((shell) => shell.name === name);
    setShells((prev) => prev.filter((shell) => shell.name !== name));
    // react-doctor-disable-next-line react-hooks-js/todo -- React Compiler cannot lower the try/finally below into memoized form; the async delete flow is correct as written
    try {
      const res = await fetch(`${getGatewayUrl()}/api/terminal/sessions/${encodeURIComponent(name)}?force=1`, {
        method: "DELETE",
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        setShellsError("Failed to remove shell");
        setShells((prev) => prev.some((shell) => shell.name === name) || !deletedShell ? prev : [...prev, deletedShell]);
        return;
      }
      ctx.removeDeletedShellSessionFromLayout(name);
      await fetchShells({ silent: true });
    } catch (err: unknown) {
      console.warn("Failed to remove shell session:", err instanceof Error ? err.message : err);
      setShellsError("Could not remove shell");
      setShells((prev) => prev.some((shell) => shell.name === name) || !deletedShell ? prev : [...prev, deletedShell]);
    } finally {
      deletingShellsRef.current!.delete(name);
      setDeletingShellNames(Array.from(deletingShellsRef.current!));
    }
  };

  const renameManagedShell = async (shell: ShellSessionSummary, nextNameRaw: string): Promise<boolean> => {
    const nextName = nextNameRaw.trim();
    if (nextName === shell.name) return true;
    if (!SHELL_SESSION_NAME_PATTERN.test(nextName)) {
      setShellsError("Use lowercase letters, numbers, and hyphens");
      return false;
    }
    setShellsError(null);
    try {
      const res = await fetch(`${getGatewayUrl()}/api/terminal/sessions/${encodeURIComponent(shell.name)}/rename`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: nextName }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        setShellsError("Failed to rename session");
        return false;
      }
      const data = (await res.json()) as { session?: ShellSessionSummary };
      const renamedShell: ShellSessionSummary = data.session?.name
        ? data.session
        : {
            ...shell,
            name: nextName,
            attachCommand: `mos shell attach ${nextName}`,
          };
      setShells((prev) => prev.map((item) => item.name === shell.name ? renamedShell : item));
      ctx.renameShellSession(shell.name, renamedShell.name);
      return true;
    } catch (err: unknown) {
      console.warn("Failed to rename shell session:", err instanceof Error ? err.message : err);
      setShellsError("Could not rename session");
      return false;
    }
  };

  const patchShellUiState = async (
    name: string,
    patch: ShellUiStatePatch,
    options: { rollbackOnFailure?: boolean } = {},
  ) => {
    const rollbackOnFailure = options.rollbackOnFailure ?? true;
    setShellsError(null);
    const previousValues: ShellUiStatePatch = {};
    setShells((prev) => prev.map((shell) => {
      if (shell.name !== name) return shell;
      Object.assign(previousValues, snapshotShellUiStatePatch(shell, patch));
      return applyShellUiStatePatch(shell, patch);
    }));
    const rollback = () => {
      setShells((prev) => prev.map((shell) => (
        shell.name === name
          ? rollbackShellUiStatePatch(shell, patch, previousValues)
          : shell
      )));
    };
    try {
      const res = await fetch(`${getGatewayUrl()}/api/terminal/sessions/${encodeURIComponent(name)}/ui-state`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        if (rollbackOnFailure) {
          setShellsError("Failed to update session");
          rollback();
        }
        return null;
      }
      const data = (await res.json()) as { session?: ShellSessionSummary };
      if (data.session?.name) {
        setShells((prev) => prev.map((shell) => shell.name === data.session!.name ? data.session! : shell));
        return data.session;
      }
      return null;
    } catch (err: unknown) {
      console.warn("Failed to update shell session UI state:", err instanceof Error ? err.message : err);
      if (rollbackOnFailure) {
        setShellsError("Could not update session");
        rollback();
      }
      return null;
    }
  };

  const openWorkspaceTransport = async (session: WorkspaceSessionSummary, mode: "observe" | "takeover") => {
    if (!session.id) {
      setSessionsError("Session is missing an id");
      return;
    }
    try {
      const res = await fetch(`${getGatewayUrl()}/api/sessions/${encodeURIComponent(session.id)}/${mode}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        setSessionsError("Failed to attach session");
        return;
      }
      const data = (await res.json()) as { terminalSessionId?: string };
      if (data.terminalSessionId) {
        ctx.addSessionTab(`${session.id} · ${mode}`, data.terminalSessionId);
      }
    } catch (err: unknown) {
      console.warn("Failed to attach workspace session:", err instanceof Error ? err.message : err);
      setSessionsError("Could not attach session");
    }
  };

  const duplicateWorkspaceSession = async (session: WorkspaceSessionSummary) => {
    try {
      const res = await fetch(`${getGatewayUrl()}/api/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: session.kind ?? (session.agent ? "agent" : "shell"),
          ...(session.agent ? { agent: session.agent } : {}),
          ...(session.projectSlug ? { projectSlug: session.projectSlug } : {}),
          ...(session.taskId ? { taskId: session.taskId } : {}),
          ...(session.worktreeId ? { worktreeId: session.worktreeId } : {}),
          ...(session.pr ? { pr: session.pr } : {}),
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        setSessionsError("Failed to duplicate session");
        return;
      }
      await fetchSessions();
    } catch (err: unknown) {
      console.warn("Failed to duplicate workspace session:", err instanceof Error ? err.message : err);
      setSessionsError("Could not duplicate session");
    }
  };

  const killWorkspaceSession = async (sessionId: string) => {
    try {
      const res = await fetch(`${getGatewayUrl()}/api/sessions/${encodeURIComponent(sessionId)}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        setSessionsError("Failed to kill session");
        return;
      }
      await fetchSessions();
    } catch (err: unknown) {
      console.warn("Failed to kill workspace session:", err instanceof Error ? err.message : err);
      setSessionsError("Could not kill session");
    }
  };

  const openSessionIds = new Set<string>();
  const syntheticShells: ShellSessionSummary[] = [];
  for (const terminalTab of ctx.tabs) {
    for (const sessionId of getSessionIds(terminalTab.paneTree)) {
      if (!sessionId || openSessionIds.has(sessionId)) continue;
      openSessionIds.add(sessionId);
      if (!isCanonicalShellSessionId(sessionId)) continue;
      syntheticShells.push({
        name: sessionId,
        status: "active",
        placement: "active",
        attachedClients: 1,
        tabs: [{ idx: 0, name: "main", focused: true }],
      });
    }
  }
  const syntheticFilteredShells = normalizedFilter
    ? syntheticShells.filter((shell) => [
      shell.name,
      shell.status,
      shell.tabs?.map((shellTab) => shellTab.name).join(" "),
    ].filter(Boolean).join(" ").toLowerCase().includes(normalizedFilter))
    : syntheticShells;
  const unfilteredRenderedShells = shells.length > 0
    ? shells
    : shellsAuthoritative ? [] : syntheticShells;
  const renderedShells = filteredShells.length > 0
    ? filteredShells
    : shellsAuthoritative ? [] : syntheticFilteredShells;
  const activeShells = renderedShells.filter((shell) => (shell.placement ?? (openSessionIds.has(shell.name) ? "active" : "background")) === "active");
  const backgroundShells = renderedShells.filter((shell) => (shell.placement ?? (openSessionIds.has(shell.name) ? "active" : "background")) === "background");
  const activeTerminalTab = ctx.tabs.find((terminalTab) => terminalTab.id === ctx.activeTabId) ?? ctx.tabs[0];
  const selectedPaneId = activeTerminalTab
    ? ctx.focusedPaneId && hasPaneId(activeTerminalTab.paneTree, ctx.focusedPaneId)
      ? ctx.focusedPaneId
      : getFirstPaneId(activeTerminalTab.paneTree)
    : null;
  const activePaneSessionId = activeTerminalTab && selectedPaneId
    ? getPaneSessionId(activeTerminalTab.paneTree, selectedPaneId)
    : null;
  const activeShellName = activePaneSessionId && isCanonicalShellSessionId(activePaneSessionId)
    ? activePaneSessionId
    : null;
  const drawerWidth = ctx.mobile ? "100%" : clampTerminalSidebarWidth(ctx.sidebarWidth);
  const queueFocusAfterManagedShellDelete = (shellName: string) => {
    const shellIndex = unfilteredRenderedShells.findIndex((shell) => shell.name === shellName);
    const remainingShells = unfilteredRenderedShells.filter((shell) => shell.name !== shellName);
    const targetIndex = shellIndex === -1 ? 0 : Math.min(shellIndex, remainingShells.length - 1);
    pendingDeleteFocusRef.current = {
      deletedName: shellName,
      targetName: remainingShells[targetIndex]?.name ?? null,
    };
  };
  useEffect(() => {
    const pendingFocus = pendingDeleteFocusRef.current;
    if (!pendingFocus || closeConfirmationRequest || deletingShellNames.includes(pendingFocus.deletedName)) {
      return;
    }
    pendingDeleteFocusRef.current = null;
    const sessionButtons = Array.from(
      sessionsScrollRef.current?.querySelectorAll<HTMLButtonElement>("[data-session-name]") ?? [],
    );
    const preferredButton = pendingFocus.targetName
      ? sessionButtons.find((button) => button.getAttribute("data-session-name") === pendingFocus.targetName)
      : null;
    const focusTarget = preferredButton
      ?? sessionButtons[0]
      ?? sessionsScrollRef.current
      ?? refreshSessionsButtonRef.current;
    focusTarget?.focus({ preventScroll: true });
  }, [closeConfirmationRequest, deletingShellNames]);
  const startSidebarResize = (event: ReactPointerEvent<HTMLElement>) => {
    if (ctx.mobile) return;
    event.preventDefault();
    event.stopPropagation();
    const resizeHandle = event.currentTarget;
    const pointerId = event.pointerId;
    resizeHandle.setPointerCapture?.(pointerId);
    const startX = event.clientX;
    const startWidth = clampTerminalSidebarWidth(ctx.sidebarWidth);
    const handlePointerMove = (moveEvent: globalThis.PointerEvent) => {
      ctx.setSidebarWidth(clampTerminalSidebarWidth(startWidth + moveEvent.clientX - startX));
    };
    const finishResize = () => {
      if (resizeHandle.hasPointerCapture?.(pointerId)) {
        resizeHandle.releasePointerCapture?.(pointerId);
      }
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", finishResize);
      window.removeEventListener("pointercancel", finishResize);
    };
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", finishResize, { once: true });
    window.addEventListener("pointercancel", finishResize, { once: true });
  };
  const resizeSidebarWithKeyboard = (event: KeyboardEvent<HTMLElement>) => {
    if (ctx.mobile) return;
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const delta = event.key === "ArrowLeft" ? -16 : 16;
    ctx.setSidebarWidth((width) => clampTerminalSidebarWidth(width + delta));
  };
  const openActiveShell = (shell: ShellSessionSummary, options: { markSeen?: boolean } = {}) => {
    const markSeen = options.markSeen !== false;
    const existingTab = ctx.tabs.find((tab) => getSessionIds(tab.paneTree).includes(shell.name));
    if (existingTab) {
      ctx.setActiveTab(existingTab.id);
    } else {
      ctx.addSessionTab(formatShellDisplayName(shell.name), shell.name);
    }
    if (markSeen && shell.latestSeq !== undefined && shell.latestSeq !== null && shell.lastSeenSeq !== shell.latestSeq) {
      void patchShellUiState(shell.name, { lastSeenSeq: shell.latestSeq });
    }
    if (ctx.mobile) {
      ctx.setSidebarOpen(false);
    }
  };

  const moveShellToBackground = (shell: ShellSessionSummary) => {
    void patchShellUiState(shell.name, { placement: "background" });
    ctx.backgroundShellSession(shell.name);
  };

  const makeShellActive = (shell: ShellSessionSummary) => {
    void patchShellUiState(shell.name, {
      placement: "active",
      ...(shell.latestSeq !== undefined && shell.latestSeq !== null ? { lastSeenSeq: shell.latestSeq } : {}),
    }, { rollbackOnFailure: false });
    openActiveShell(shell, { markSeen: false });
  };

  const placementForShell = (shell: ShellSessionSummary): "active" | "background" => (
    shell.placement ?? (openSessionIds.has(shell.name) ? "active" : "background")
  );

  const reorderShells = async (fromName: string, toName: string) => {
    if (fromName === toName) return;
    const fromIndex = shells.findIndex((shell) => shell.name === fromName);
    const toIndex = shells.findIndex((shell) => shell.name === toName);
    if (fromIndex < 0 || toIndex < 0) return;
    const nextShells = [...shells];
    const [moved] = nextShells.splice(fromIndex, 1);
    if (!moved) return;
    nextShells.splice(toIndex, 0, moved);
    reorderSaveCountRef.current += 1;
    setShells(nextShells);
    setShellsError(null);
    const finishReorderSave = () => {
      reorderSaveCountRef.current = Math.max(0, reorderSaveCountRef.current - 1);
    };
    try {
      const res = await fetch(`${getGatewayUrl()}/api/terminal/sessions/order`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ order: nextShells.map((shell) => shell.name) }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        setShellsError("Shell order could not be saved");
        await fetchShells({ silent: true });
        finishReorderSave();
        return;
      }
      const data = (await res.json()) as { sessions?: ShellSessionSummary[] };
      if (Array.isArray(data.sessions)) {
        commitShellRefreshState(applyShellRefreshSuccess(
          shellRefreshStateRef.current,
          data.sessions,
          true,
        ));
      } else {
        await fetchShells({ silent: true });
      }
      finishReorderSave();
    } catch (err: unknown) {
      console.warn("Failed to save shell order:", err instanceof Error ? err.message : err);
      setShellsError("Shell order could not be saved");
      await fetchShells({ silent: true });
      finishReorderSave();
    }
  };

  const finishShellDrag = () => {
    setDraggingShellName(null);
    setDragOverShellName(null);
    setDraggingShellPlacement(null);
  };

  const beginShellDrag = (shell: ShellSessionSummary) => {
    setDraggingShellName(shell.name);
    setDraggingShellPlacement(placementForShell(shell));
    setDragOverShellName(null);
  };

  const hoverShellDropTarget = (shell: ShellSessionSummary) => {
    if (!draggingShellName || draggingShellName === shell.name) return;
    if (draggingShellPlacement && draggingShellPlacement !== placementForShell(shell)) return;
    setDragOverShellName(shell.name);
  };

  const dropShellOnTarget = (shell: ShellSessionSummary) => {
    if (draggingShellPlacement && draggingShellPlacement !== placementForShell(shell)) {
      finishShellDrag();
      return;
    }
    if (draggingShellName && draggingShellName !== shell.name) {
      void reorderShells(draggingShellName, shell.name);
    }
    finishShellDrag();
  };

  const openNewSessionMenu = (anchor: NewSessionMenuAnchor) => {
    if (creatingShell) return;
    if (newSessionMenuAnchor !== anchor) {
      setAgentStatuses(null);
      void fetchAgentStatuses();
    }
    setNewSessionMenuAnchor((current) => current === anchor ? null : anchor);
  };

  const createAgentSession = async (option: TerminalAgentOption, installed: boolean) => {
    if (creatingShellRef.current) return;
    setNewSessionMenuAnchor(null);
    creatingShellRef.current = true;
    setCreatingShell(true);
    setShellsError(null);
    const cwd = ctx.sidebarSelectedPath ?? DEFAULT_CWD;
    try {
      const label = installed ? option.label : `Install ${option.label}`;
      const cmd = installed
        ? option.launchCommand ?? (option.claudeMode ? "claude" : undefined)
        : terminalAgentVisibleInstallCommand(option);
      const name = await ctx.createShellSessionTab(label, cwd, {
        cmd,
        ...(installed ? { agent: option.id } : {}),
        ...(installed && option.id === "codex" ? { compatMode: "codex-tui" } : {}),
      });
      if (name) {
        await fetchShells({ silent: true });
      } else {
        setShellsError("Failed to create agent session");
      }
    } catch (err: unknown) {
      console.warn("Failed to create agent session:", err instanceof Error ? err.message : err);
      setShellsError("Could not create agent session");
    }
    creatingShellRef.current = false;
    setCreatingShell(false);
    if (ctx.mobile) {
      ctx.setSidebarOpen(false);
    }
  };

  const pendingCloseRequest = closeConfirmationRequest
    ? {
        ...closeConfirmationRequest,
        shell: unfilteredRenderedShells.find((shell) => shell.name === closeConfirmationRequest.shell.name) ?? closeConfirmationRequest.shell,
      }
    : null;
  const closeConfirmationOverlay = pendingCloseRequest ? (
    <ShellCloseConfirmation
      key={pendingCloseRequest.shell.name}
      shell={pendingCloseRequest.shell}
      anchorElement={pendingCloseRequest.anchorElement}
      mobile={ctx.mobile}
      deleting={deletingShellNames.includes(pendingCloseRequest.shell.name)}
      onCancel={() => {
        setCloseConfirmationRequest(null);
        pendingCloseRequest.returnFocusElement.focus({ preventScroll: true });
      }}
      onConfirm={() => {
        const shellName = pendingCloseRequest.shell.name;
        queueFocusAfterManagedShellDelete(shellName);
        setCloseConfirmationRequest(null);
        void deleteManagedShell(shellName);
      }}
    />
  ) : null;
  const statusDotStyles = <style>{SHELL_STATUS_DOT_CSS}</style>;

  if (!ctx.sidebarOpen && !ctx.mobile) {
    return (
      <>
        {statusDotStyles}
        <div
          data-testid="terminal-sidebar-shell"
          className="shrink-0"
          style={{
            display: "flex",
            minHeight: 0,
            opacity: 1,
            overflow: "visible",
            transform: "translateX(0)",
            transition: TERMINAL_SIDEBAR_TRANSITION,
            width: 76,
          }}
        >
          <CollapsedSessionsRail
            shells={unfilteredRenderedShells}
            selectedShellName={activeShellName}
            terminalDividerColor="var(--terminal-drawer-border)"
            onExpand={() => ctx.setSidebarOpen(true)}
            creatingShell={creatingShell}
            newSessionMenuOpen={newSessionMenuAnchor === "rail"}
            onNew={() => openNewSessionMenu("rail")}
            onNewMenuClose={() => setNewSessionMenuAnchor(null)}
            onCreateShell={() => void createManagedShell()}
            onCreateAgent={createAgentSession}
            agentStatuses={agentStatuses}
            onOpen={makeShellActive}
          />
        </div>
        {closeConfirmationOverlay}
      </>
    );
  }

  if (!ctx.sidebarOpen) {
    return (
      <>
        {statusDotStyles}
        {closeConfirmationOverlay}
      </>
    );
  }

  return (
    <>
      {statusDotStyles}
      <div
        data-testid="terminal-sidebar-shell"
        className="shrink-0 overflow-hidden"
        style={{
          background: "var(--terminal-drawer-bg)",
          borderRight: ctx.mobile ? "none" : "1px solid var(--terminal-drawer-border)",
          borderBottom: ctx.mobile ? "1px solid var(--terminal-drawer-border)" : "none",
          color: "var(--terminal-drawer-fg)",
          display: "flex",
          flexDirection: "column",
          maxHeight: ctx.mobile ? "52%" : undefined,
          minHeight: ctx.mobile ? 360 : undefined,
          opacity: 1,
          overflow: "visible",
          position: "relative",
          transform: "translateX(0)",
          transition: ctx.mobile ? undefined : TERMINAL_SIDEBAR_TRANSITION,
          width: drawerWidth,
        }}
      >
      <div
        className="shrink-0"
        style={{
          background: "var(--terminal-drawer-bg)",
          borderBottom: "1px solid var(--terminal-drawer-border)",
          display: "flex",
          flexDirection: "column",
          gap: 18,
          padding: ctx.mobile ? "16px 20px" : "19px 24px 18px",
        }}
      >
        <div className="flex items-center justify-between" style={{ gap: 16 }}>
          <div className="flex min-w-0 items-center" style={{ gap: 12 }}>
            <div
              data-testid="terminal-expanded-brand"
              className="flex shrink-0 items-center justify-center"
              style={{
                alignSelf: "center",
                background: "var(--terminal-drawer-brand-bg)",
                borderRadius: ctx.mobile ? 12 : 10,
                height: ctx.mobile ? 40 : 38,
                width: ctx.mobile ? 40 : 38,
              }}
            >
              <span
                aria-hidden="true"
                data-testid="terminal-expanded-brand-mask"
                style={{
                  background: "var(--terminal-drawer-brand-fg)",
                  WebkitMaskImage: "url('/matrix-logo.svg')",
                  maskImage: "url('/matrix-logo.svg')",
                  WebkitMaskRepeat: "no-repeat",
                  maskRepeat: "no-repeat",
                  WebkitMaskPosition: "center",
                  maskPosition: "center",
                  WebkitMaskSize: "contain",
                  maskSize: "contain",
                  display: "block",
                  height: ctx.mobile ? 22 : 22,
                  width: ctx.mobile ? 22 : 22,
                }}
              />
            </div>
            <div className="min-w-0">
              <div style={{ color: "var(--terminal-drawer-fg)", fontFamily: "var(--font-sans), system-ui, sans-serif", fontSize: 20, fontWeight: 600, letterSpacing: "-0.01em", lineHeight: "24px" }}>
                matrix os
              </div>
              {!ctx.mobile ? (
                <div className="truncate" style={{ color: "var(--terminal-drawer-muted)", fontFamily: "var(--font-mono, ui-monospace, monospace)", fontSize: 13, lineHeight: "17px" }}>
                  {ctx.sidebarSelectedPath ? formatCwd(ctx.sidebarSelectedPath) : "~/projects"}
                </div>
              ) : null}
            </div>
          </div>
          <div className="flex shrink-0 items-center" style={{ gap: 10 }}>
            {!ctx.mobile ? (
              <div style={{ position: "relative" }}>
                <button
                  type="button"
                  aria-label="New session"
                  aria-haspopup="menu"
                  aria-expanded={newSessionMenuAnchor === "drawer"}
                  onClick={() => openNewSessionMenu("drawer")}
                  disabled={creatingShell}
                  className="flex items-center justify-center"
                  style={{
                    background: "var(--terminal-drawer-primary-button-bg)",
                    border: 0,
                    borderRadius: 10,
                    color: "var(--terminal-drawer-primary-button-fg)",
                    cursor: creatingShell ? "not-allowed" : "pointer",
                    fontSize: 25,
                    height: 40,
                    lineHeight: "28px",
                    opacity: creatingShell ? 0.72 : 1,
                    width: 40,
                  }}
                >
                  <PlusIcon aria-hidden="true" size={18} strokeWidth={2.5} />
                </button>
                {newSessionMenuAnchor === "drawer" ? (
                  <NewSessionMenu
                    align="right"
                    onClose={() => setNewSessionMenuAnchor(null)}
                    onCreateShell={() => void createManagedShell()}
                    onCreateAgent={createAgentSession}
                    agentStatuses={agentStatuses}
                  />
                ) : null}
              </div>
            ) : null}
            {!ctx.mobile && (
              <>
                <button
                  ref={refreshSessionsButtonRef}
                  type="button"
                  aria-label="Refresh sessions"
                  onClick={() => void fetchShells()}
                  disabled={shellsLoading}
                  className="flex items-center justify-center"
                  style={{
                    background: "var(--terminal-drawer-button-bg)",
                    border: "1px solid var(--terminal-drawer-button-border)",
                    borderRadius: 10,
                    color: "var(--terminal-drawer-button-fg)",
                    cursor: shellsLoading ? "not-allowed" : "pointer",
                    height: 40,
                    opacity: shellsLoading ? 0.72 : 1,
                    width: 40,
                  }}
                >
                  <RefreshCwIcon
                    className={shellsLoading ? "terminal-refresh-icon--loading" : undefined}
                    data-testid="terminal-refresh-icon"
                    size={17}
                    strokeWidth={1.9}
                  />
                </button>
                <button
                  type="button"
                  aria-label="Hide sessions drawer"
                  onClick={() => ctx.setSidebarOpen(false)}
                  className="flex items-center justify-center"
                  style={{
                    background: "var(--terminal-drawer-button-bg)",
                    border: "1px solid var(--terminal-drawer-button-border)",
                    borderRadius: 10,
                    color: "var(--terminal-drawer-button-fg)",
                    cursor: "pointer",
                    height: 40,
                    width: 40,
                  }}
                >
                  <ChevronsLeftIcon data-testid="terminal-drawer-collapse-icon" size={17} strokeWidth={2} />
                </button>
              </>
            )}
          </div>
        </div>
        <div
          className="flex items-center"
          style={{
            background: "var(--terminal-drawer-search-bg)",
            border: "1px solid var(--terminal-drawer-search-border)",
            borderRadius: ctx.mobile ? 14 : 10,
            gap: 10,
            height: ctx.mobile ? 48 : 40,
            padding: "0 14px",
          }}
        >
          <SearchIcon size={18} strokeWidth={1.9} color="var(--terminal-drawer-search-icon)" />
          <input
            aria-label="Search sessions"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Find a session..."
            style={{
              background: "transparent",
              border: 0,
              color: "var(--terminal-drawer-fg)",
              flex: 1,
              fontSize: ctx.mobile ? 16 : 15,
              minWidth: 0,
            }}
          />
        </div>
      </div>

      <div
        ref={sessionsScrollRef}
        data-testid="terminal-sessions-scroll"
        data-terminal-scrollbar="drawer"
        tabIndex={-1}
        className="terminal-sessions-scroll min-h-0 flex-1 overflow-y-auto"
        style={{ display: "flex", flexDirection: "column", gap: 18, padding: ctx.mobile ? 20 : 18 }}
      >
        {shellsLoading && (
          <div style={{ color: "var(--terminal-drawer-muted)", fontSize: 12, padding: "24px 0", textAlign: "center" }}>Loading sessions...</div>
        )}
        {!shellsLoading && shellsStale && renderedShells.length > 0 && (
          <div
            data-testid="terminal-sessions-stale-label"
            style={{
              background: "#FFF7DA",
              border: "1px solid #EADFAE",
              borderRadius: 8,
              color: "#7C5A0B",
              fontSize: 12,
              lineHeight: "16px",
              padding: "9px 10px",
              textAlign: "center",
            }}
          >
            Terminal session data is stale. Retry refresh.
          </div>
        )}
        {!shellsLoading && shellsError && (
          <div style={{ color: "#8F6712", fontSize: 12, padding: "24px 0", textAlign: "center" }}>{shellsError}</div>
        )}
        {!shellsLoading && !shellsError && !creatingShell && renderedShells.length === 0 && (
          <div style={{ color: "var(--terminal-drawer-muted)", fontSize: 12, padding: "24px 0", textAlign: "center" }}>
            {filter ? "No sessions match" : "No sessions yet"}
          </div>
        )}
        {!shellsLoading && (activeShells.length > 0 || creatingShell) && (
          <ShellSessionGroup
            label="Active"
            shells={activeShells}
            pending={creatingShell}
            deletingShellNames={deletingShellNames}
            foreground
            selectedShellName={activeShellName}
            onOpen={openActiveShell}
            onToggle={moveShellToBackground}
            onRename={(shell, nextName) => renameManagedShell(shell, nextName)}
            onDelete={(shell, anchorElement, returnFocusElement) => setCloseConfirmationRequest({ shell, anchorElement, returnFocusElement })}
            draggingShellName={draggingShellName}
            dragOverShellName={dragOverShellName}
            onDragStart={beginShellDrag}
            onDragOver={hoverShellDropTarget}
            onDrop={dropShellOnTarget}
            onDragEnd={finishShellDrag}
          />
        )}
        {!shellsLoading && renderedShells.length > 0 && (
          <ShellSessionGroup
            label="Background"
            shells={backgroundShells}
            expanded={backgroundSessionsExpanded}
            onToggleExpanded={() => setBackgroundSessionsExpanded((expanded) => !expanded)}
            deletingShellNames={deletingShellNames}
            foreground={false}
            selectedShellName={activeShellName}
            onOpen={makeShellActive}
            onToggle={makeShellActive}
            onRename={(shell, nextName) => renameManagedShell(shell, nextName)}
            onDelete={(shell, anchorElement, returnFocusElement) => setCloseConfirmationRequest({ shell, anchorElement, returnFocusElement })}
            draggingShellName={draggingShellName}
            dragOverShellName={dragOverShellName}
            onDragStart={beginShellDrag}
            onDragOver={hoverShellDropTarget}
            onDrop={dropShellOnTarget}
            onDragEnd={finishShellDrag}
          />
        )}
      </div>
      <div
        data-testid="terminal-sidebar-footer"
        className="shrink-0"
        style={{
          alignItems: "center",
          background: "var(--terminal-drawer-bg)",
          borderTop: "1px solid var(--terminal-drawer-border)",
          display: "flex",
          justifyContent: "flex-start",
          padding: ctx.mobile ? "13px 20px calc(13px + env(safe-area-inset-bottom))" : "12px 18px",
        }}
      >
        <ThemePickerButton mobile={ctx.mobile} menuPlacement="above-start" />
      </div>
      {!ctx.mobile ? (
        <button
          type="button"
          aria-label="Resize sessions drawer"
          className="terminal-drawer-resize-handle"
          onPointerDown={startSidebarResize}
          onKeyDown={resizeSidebarWithKeyboard}
          style={{
            background: "var(--terminal-drawer-resize-handle-bg)",
            border: 0,
            bottom: 0,
            cursor: "col-resize",
            margin: 0,
            outline: "none",
            position: "absolute",
            right: 0,
            top: 0,
            width: 8,
            zIndex: 5,
          }}
        />
      ) : null}
    </div>
      {closeConfirmationOverlay}
    </>
  );
}
