// Merges owner-visible terminal workspace tabs with coding workspace records.
// Every attach target is a stable Matrix TerminalRef key; internal Zellij
// names and pane IDs never cross this client boundary.

export interface TerminalWorkspaceDTO {
  id: string;
  scope?: "main" | "project";
  projectId?: string;
  tabs?: Array<{
    id?: string;
    name?: string;
    cwd?: string;
    status?: string;
    agent?: { providerId?: string };
  }>;
}

export interface WorkspaceSessionDTO {
  id?: string;
  sessionId?: string;
  name?: string;
  kind?: string;
  agent?: string;
  projectSlug?: string;
  taskId?: string | null;
  worktreeId?: string | null;
  runtime?: { terminalRef?: { workspaceId?: string; tabId?: string } | null; status?: string } | null;
  status?: string;
}

export interface AttachableSession {
  name: string;
  attachName: string;
  status: "active" | "exited";
  source: "terminal-tab" | "workspace";
  kind?: "shell" | "agent";
  agent?: string;
  projectSlug?: string;
  taskId?: string;
  worktreeId?: string;
  runtimeStatus?: string;
  projectId?: string;
  cwd?: string;
}

export interface SessionMergeResult {
  sessions: AttachableSession[];
  aliasMap: Record<string, string>;
}

const WORKSPACE_ID = /^tws_[0-9a-f]{32}$/;
const TAB_ID = /^tt_[0-9a-f]{32}$/;
const EXITED_STATUSES = new Set(["exited", "failed", "unavailable"]);

function refKey(ref: { workspaceId?: string; tabId?: string } | null | undefined): string | null {
  return ref && WORKSPACE_ID.test(ref.workspaceId ?? "") && TAB_ID.test(ref.tabId ?? "")
    ? `${ref.workspaceId}:${ref.tabId}`
    : null;
}

function workspaceMeta(record: WorkspaceSessionDTO): Partial<AttachableSession> {
  return {
    ...(record.kind === "shell" || record.kind === "agent" ? { kind: record.kind } : {}),
    ...(typeof record.agent === "string" && record.agent ? { agent: record.agent } : {}),
    ...(typeof record.projectSlug === "string" && record.projectSlug ? { projectSlug: record.projectSlug } : {}),
    ...(typeof record.taskId === "string" && record.taskId ? { taskId: record.taskId } : {}),
    ...(typeof record.worktreeId === "string" && record.worktreeId ? { worktreeId: record.worktreeId } : {}),
    ...(typeof record.runtime?.status === "string" ? { runtimeStatus: record.runtime.status } : {}),
  };
}

export function mergeAttachableSessions(
  terminalWorkspaces: TerminalWorkspaceDTO[],
  workspaceSessions: WorkspaceSessionDTO[],
): SessionMergeResult {
  const sessions: AttachableSession[] = [];
  const byAttach = new Map<string, AttachableSession>();
  const aliasMap: Record<string, string> = {};

  for (const workspace of terminalWorkspaces) {
    if (!WORKSPACE_ID.test(workspace.id)) continue;
    for (const tab of workspace.tabs ?? []) {
      if (!TAB_ID.test(tab.id ?? "")) continue;
      const attachName = `${workspace.id}:${tab.id}`;
      const session: AttachableSession = {
        name: typeof tab.name === "string" && tab.name ? tab.name : tab.id!,
        attachName,
        status: EXITED_STATUSES.has(tab.status ?? "") ? "exited" : "active",
        source: "terminal-tab",
        ...(workspace.projectId ? { projectId: workspace.projectId } : {}),
        ...(typeof tab.cwd === "string" ? { cwd: tab.cwd } : {}),
        ...(typeof tab.agent?.providerId === "string" ? { agent: tab.agent.providerId } : {}),
      };
      sessions.push(session);
      byAttach.set(attachName, session);
      aliasMap[attachName] = attachName;
    }
  }

  for (const record of workspaceSessions) {
    const attachName = refKey(record.runtime?.terminalRef);
    if (!attachName) continue;
    for (const alias of [record.id, record.sessionId, record.name, attachName]) {
      if (alias) aliasMap[alias] = attachName;
    }
    const existing = byAttach.get(attachName);
    if (existing) {
      Object.assign(existing, workspaceMeta(record));
      continue;
    }
    const session: AttachableSession = {
      name: record.name || attachName,
      attachName,
      status: EXITED_STATUSES.has(record.runtime?.status ?? record.status ?? "") ? "exited" : "active",
      source: "workspace",
      ...workspaceMeta(record),
    };
    sessions.push(session);
    byAttach.set(attachName, session);
  }

  return { sessions, aliasMap };
}
