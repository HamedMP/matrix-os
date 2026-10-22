import {
  SafeDisplayStringSchema,
  TerminalTabIdSchema,
  TerminalWorkspaceIdSchema,
} from "@matrix-os/contracts";
import { z } from "zod/v4";

import {
  buildGatewayRequestUrl,
  fetchAuthenticatedJson,
  fetchAuthenticatedResponse,
} from "@/lib/requests/http";

const TERMINALS_UNAVAILABLE_ERROR = "Terminals unavailable. Try again.";
const TERMINAL_CREATE_ERROR = "Could not create terminal. Try again.";
const TERMINAL_RENAME_ERROR = "Could not rename terminal. Try again.";
const TERMINAL_DELETE_ERROR = "Could not delete terminal. Try again.";
const MAX_TERMINAL_WORKSPACES = 1_000;
const MAX_TERMINAL_SESSIONS = 1_000;
const DEFAULT_TERMINAL_CWD = "projects";
const TERMINAL_AGENTS = ["claude", "codex", "opencode", "pi"] as const;

export const TERMINAL_SESSION_NAME_MAX_LENGTH = 120;

// The list is read with only the fields this screen uses and without `.strict()`,
// so a computer on a newer release than this build still lists its terminals.
const TerminalTabSchema = z.object({
  id: TerminalTabIdSchema,
  name: z.string().min(1).max(512),
  cwd: z.string().max(4_096).optional(),
  status: z.string().max(32),
  revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  accessScope: z.string().max(32).optional(),
  agent: z.object({ providerId: z.string().max(80) }).optional(),
  git: z.object({ branch: z.string().min(1).max(255) }).optional(),
});

const TerminalWorkspaceSchema = z.object({
  id: TerminalWorkspaceIdSchema,
  projectId: z.string().min(1).max(160).optional(),
  tabs: z.array(z.unknown()).max(10_000),
});

const TerminalWorkspacesResponseSchema = z.object({
  workspaces: z.array(z.unknown()).max(MAX_TERMINAL_WORKSPACES),
});

const TerminalWorkspaceEnsureResponseSchema = z.object({
  workspace: z.object({ id: TerminalWorkspaceIdSchema }),
});

const TerminalTabMutationResponseSchema = z.object({
  tab: z.object({ id: TerminalTabIdSchema }),
});

export interface TerminalSession {
  /** Serialized TerminalRef (`workspaceId:tabId`): the route param and the tab socket address. */
  id: string;
  workspaceId: string;
  tabId: string;
  /** Tab revision the list last showed; a rename sends it as its base. */
  revision: number;
  name: string;
  cwd: string;
  status: "active" | "exited" | "degraded";
  visualStatus: "running" | "waiting" | "idle";
  agent?: typeof TERMINAL_AGENTS[number];
  branch?: string;
  projectId?: string;
}

export type TerminalSessionRef = Pick<TerminalSession, "workspaceId" | "tabId">;

function sessionStatus(status: string): Pick<TerminalSession, "status" | "visualStatus"> {
  if (status === "exited") return { status: "exited", visualStatus: "idle" };
  if (status === "failed" || status === "unavailable") return { status: "degraded", visualStatus: "waiting" };
  if (status === "idle") return { status: "active", visualStatus: "idle" };
  return { status: "active", visualStatus: "running" };
}

function toTerminalSessions(workspaces: unknown[]): TerminalSession[] {
  const sessions: TerminalSession[] = [];
  for (const entry of workspaces) {
    const workspace = TerminalWorkspaceSchema.safeParse(entry);
    if (!workspace.success) continue;
    for (const tabEntry of workspace.data.tabs) {
      if (sessions.length >= MAX_TERMINAL_SESSIONS) return sessions;
      const tab = TerminalTabSchema.safeParse(tabEntry);
      // A chat's terminal attaches only with that chat's context, so it has no row here.
      if (!tab.success || tab.data.accessScope === "chat") continue;
      const agent = TERMINAL_AGENTS.find((candidate) => candidate === tab.data.agent?.providerId);
      sessions.push({
        id: `${workspace.data.id}:${tab.data.id}`,
        workspaceId: workspace.data.id,
        tabId: tab.data.id,
        revision: tab.data.revision,
        name: tab.data.name,
        cwd: tab.data.cwd ?? "",
        ...sessionStatus(tab.data.status),
        ...(agent ? { agent } : {}),
        ...(tab.data.git ? { branch: tab.data.git.branch } : {}),
        ...(workspace.data.projectId ? { projectId: workspace.data.projectId } : {}),
      });
    }
  }
  return sessions;
}

function isTerminalSessionRef(ref: TerminalSessionRef): boolean {
  return TerminalWorkspaceIdSchema.safeParse(ref.workspaceId).success
    && TerminalTabIdSchema.safeParse(ref.tabId).success;
}

export function isValidTerminalSessionName(value: string): boolean {
  return SafeDisplayStringSchema.safeParse(value).success;
}

export function fetchTerminalSessions(
  clerkToken: string,
  computerGatewayUrl: string,
): Promise<TerminalSession[]> {
  let url: string;
  try {
    url = buildGatewayRequestUrl(computerGatewayUrl, "/api/terminal/workspaces");
  } catch {
    return Promise.reject(new Error(TERMINALS_UNAVAILABLE_ERROR));
  }

  return fetchAuthenticatedJson({
    url,
    token: clerkToken,
    schema: TerminalWorkspacesResponseSchema,
    errorMessage: TERMINALS_UNAVAILABLE_ERROR,
  }).then((response) => toTerminalSessions(response.workspaces));
}

/** Create a tab in the computer's main workspace and return its serialized TerminalRef. */
export async function createTerminalSession(
  clerkToken: string,
  computerGatewayUrl: string,
  name: string,
): Promise<string> {
  if (!isValidTerminalSessionName(name)) throw new Error(TERMINAL_CREATE_ERROR);
  let ensureUrl: string;
  try {
    ensureUrl = buildGatewayRequestUrl(computerGatewayUrl, "/api/terminal/workspaces/ensure");
  } catch {
    throw new Error(TERMINAL_CREATE_ERROR);
  }
  const ensured = await fetchAuthenticatedJson({
    url: ensureUrl,
    token: clerkToken,
    schema: TerminalWorkspaceEnsureResponseSchema,
    errorMessage: TERMINAL_CREATE_ERROR,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  const workspaceId = ensured.workspace.id;
  const created = await fetchAuthenticatedJson({
    url: buildGatewayRequestUrl(computerGatewayUrl, `/api/terminal/workspaces/${workspaceId}/tabs`),
    token: clerkToken,
    schema: TerminalTabMutationResponseSchema,
    errorMessage: TERMINAL_CREATE_ERROR,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, cwd: DEFAULT_TERMINAL_CWD }),
  });
  return `${workspaceId}:${created.tab.id}`;
}

export async function renameTerminalSession(
  clerkToken: string,
  computerGatewayUrl: string,
  session: TerminalSessionRef & Pick<TerminalSession, "revision">,
  nextName: string,
): Promise<void> {
  if (!isTerminalSessionRef(session) || !isValidTerminalSessionName(nextName)) {
    throw new Error(TERMINAL_RENAME_ERROR);
  }
  let url: string;
  try {
    url = buildGatewayRequestUrl(
      computerGatewayUrl,
      `/api/terminal/workspaces/${session.workspaceId}/tabs/${session.tabId}`,
    );
  } catch {
    throw new Error(TERMINAL_RENAME_ERROR);
  }
  await fetchAuthenticatedJson({
    url,
    token: clerkToken,
    schema: TerminalTabMutationResponseSchema,
    errorMessage: TERMINAL_RENAME_ERROR,
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: nextName, baseRevision: session.revision }),
  });
}

export async function deleteTerminalSession(
  clerkToken: string,
  computerGatewayUrl: string,
  session: TerminalSessionRef,
): Promise<void> {
  if (!isTerminalSessionRef(session)) throw new Error(TERMINAL_DELETE_ERROR);
  let url: string;
  try {
    url = buildGatewayRequestUrl(
      computerGatewayUrl,
      `/api/terminal/workspaces/${session.workspaceId}/tabs/${session.tabId}`,
    );
  } catch {
    throw new Error(TERMINAL_DELETE_ERROR);
  }
  // Success is an empty 204, and a tab another device already removed answers 404.
  await fetchAuthenticatedResponse(
    {
      url,
      token: clerkToken,
      errorMessage: TERMINAL_DELETE_ERROR,
      method: "DELETE",
      expectedStatuses: [404],
    },
    async () => undefined,
  );
}
