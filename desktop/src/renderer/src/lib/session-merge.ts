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
  runtime?: { zellijSession?: string | null; status?: string } | null;
  status?: string;
}

export interface AttachableSession {
  name: string;
  attachName: string;
  status: "active" | "exited";
  source: "zellij" | "workspace";
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

export function mergeAttachableSessions(
  zellij: ZellijSessionDTO[],
  workspace: WorkspaceSessionDTO[],
): SessionMergeResult {
  const sessions: AttachableSession[] = [];
  const aliasMap: Record<string, string> = {};
  const seenAttachNames = new Set<string>();

  for (const entry of zellij) {
    const name = entry.name;
    if (!name || name.trim().length === 0 || seenAttachNames.has(name)) continue;
    seenAttachNames.add(name);
    sessions.push({
      name,
      attachName: name,
      status: entry.status === "exited" ? "exited" : "active",
      source: "zellij",
    });
    aliasMap[name] = name;
  }

  for (const record of workspace) {
    const attachName = record.runtime?.zellijSession;
    if (!attachName || attachName.trim().length === 0) continue;

    for (const alias of [record.id, record.sessionId, record.name, attachName]) {
      if (alias && alias.trim().length > 0) aliasMap[alias] = attachName;
    }

    // Zellij (or an earlier record) already owns this attach name — its
    // status wins, only the aliases above are added.
    if (seenAttachNames.has(attachName)) continue;
    seenAttachNames.add(attachName);
    sessions.push({
      name: record.name && record.name.trim().length > 0 ? record.name : attachName,
      attachName,
      status: workspaceStatus(record),
      source: "workspace",
    });
  }

  return { sessions, aliasMap };
}
