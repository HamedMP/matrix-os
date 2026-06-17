// Merges zellij sessions (GET /api/terminal/sessions) with workspace session
// records (GET /api/sessions) into the single attachable list (L6). Workspace
// records without runtime.zellijSession are orchestrator-only and must NEVER
// become attach targets — their UUIDs caused infinite session_not_found
// retries in the 092 prototype.

export interface ZellijSessionDTO {
  name: string;
  status?: "active" | "exited";
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
  runtime?: { zellijSession?: string | null; status?: string } | null;
  status?: string;
}

export interface AttachableSession {
  name: string;
  attachName: string;
  status: "active" | "exited";
  source: "zellij" | "workspace";
  // Workspace-only metadata (absent for plain zellij shells): the session kind,
  // the agent CLI when kind==="agent", and the fine-grained runtime status
  // (running | waiting | idle | failed | …) that drives the agent-run badge.
  kind?: "shell" | "agent";
  agent?: string;
  projectSlug?: string;
  taskId?: string;
  worktreeId?: string;
  runtimeStatus?: string;
}

export interface SessionMergeResult {
  sessions: AttachableSession[];
  aliasMap: Record<string, string>;
}

const EXITED_STATUSES = new Set(["exited", "failed"]);

function workspaceStatus(record: WorkspaceSessionDTO): "active" | "exited" {
  const status = record.runtime?.status ?? record.status;
  return status !== undefined && EXITED_STATUSES.has(status) ? "exited" : "active";
}

// Optional workspace metadata, added only when present so plain zellij shells
// keep their minimal shape.
function workspaceMeta(
  record: WorkspaceSessionDTO,
): Partial<Pick<AttachableSession, "kind" | "agent" | "projectSlug" | "taskId" | "worktreeId" | "runtimeStatus">> {
  const meta: Partial<Pick<AttachableSession, "kind" | "agent" | "projectSlug" | "taskId" | "worktreeId" | "runtimeStatus">> = {};
  if (record.kind === "shell" || record.kind === "agent") meta.kind = record.kind;
  if (typeof record.agent === "string" && record.agent.length > 0) meta.agent = record.agent;
  if (typeof record.projectSlug === "string" && record.projectSlug.length > 0) meta.projectSlug = record.projectSlug;
  if (typeof record.taskId === "string" && record.taskId.length > 0) meta.taskId = record.taskId;
  if (typeof record.worktreeId === "string" && record.worktreeId.length > 0) meta.worktreeId = record.worktreeId;
  const runtimeStatus = record.runtime?.status;
  if (typeof runtimeStatus === "string" && runtimeStatus.length > 0) meta.runtimeStatus = runtimeStatus;
  return meta;
}

export function mergeAttachableSessions(
  zellij: ZellijSessionDTO[],
  workspace: WorkspaceSessionDTO[],
): SessionMergeResult {
  const sessions: AttachableSession[] = [];
  const byAttach = new Map<string, AttachableSession>();
  const aliasMap: Record<string, string> = {};
  const seenAttachNames = new Set<string>();

  for (const entry of zellij) {
    const name = entry.name;
    if (!name || name.trim().length === 0 || seenAttachNames.has(name)) continue;
    seenAttachNames.add(name);
    const session: AttachableSession = {
      name,
      attachName: name,
      status: entry.status === "exited" ? "exited" : "active",
      source: "zellij",
    };
    sessions.push(session);
    byAttach.set(name, session);
    aliasMap[name] = name;
  }

  for (const record of workspace) {
    const attachName = record.runtime?.zellijSession;
    if (!attachName || attachName.trim().length === 0) continue;

    for (const alias of [record.id, record.sessionId, record.name, attachName]) {
      if (alias && alias.trim().length > 0) aliasMap[alias] = attachName;
    }

    // Zellij (or an earlier record) already owns this attach name — its status
    // wins, but enrich it with the workspace metadata (kind/agent/run status).
    if (seenAttachNames.has(attachName)) {
      const existing = byAttach.get(attachName);
      if (existing) Object.assign(existing, workspaceMeta(record));
      continue;
    }
    seenAttachNames.add(attachName);
    const session: AttachableSession = {
      name: record.name && record.name.trim().length > 0 ? record.name : attachName,
      attachName,
      status: workspaceStatus(record),
      source: "workspace",
      ...workspaceMeta(record),
    };
    sessions.push(session);
    byAttach.set(attachName, session);
  }

  return { sessions, aliasMap };
}
