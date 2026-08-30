import { z } from "zod/v4";

import {
  buildGatewayRequestUrl,
  fetchAuthenticatedJson,
} from "@/lib/requests/http";

const TERMINALS_UNAVAILABLE_ERROR = "Terminals unavailable. Try again.";
const TERMINAL_RENAME_ERROR = "Could not rename terminal. Try again.";
const TERMINAL_DELETE_ERROR = "Could not delete terminal. Try again.";
const MAX_TERMINAL_SESSIONS = 1_000;
const TERMINAL_SESSION_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const EDITABLE_TERMINAL_SESSION_NAME = /^[a-z0-9][a-z0-9-]{0,30}$/;

const TerminalSessionSchema = z.object({
  name: z.string().regex(TERMINAL_SESSION_NAME),
  status: z.enum(["active", "exited", "degraded"]),
  cwd: z.string().max(4_096).optional(),
  visualStatus: z.enum(["running", "waiting", "finished", "idle"]),
  placement: z.enum(["active", "background"]).optional(),
  updatedAt: z.string().max(64).optional(),
  attachedClients: z.number().int().nonnegative().optional(),
  unread: z.boolean().optional(),
  agent: z.enum(["claude", "codex", "opencode", "pi"]).optional(),
  subtitle: z.string().max(120).optional(),
  lastAction: z.string().max(160).optional(),
  project: z.string().max(512).optional(),
  repository: z.string().max(512).optional(),
  branch: z.string().max(512).optional(),
});

const TerminalSessionsResponseSchema = z.object({
  sessions: z.array(TerminalSessionSchema).max(MAX_TERMINAL_SESSIONS),
});

const TerminalRenameResponseSchema = z.object({
  session: z.object({ name: z.string().regex(EDITABLE_TERMINAL_SESSION_NAME) }),
});

const TerminalDeleteResponseSchema = z.object({ ok: z.literal(true) });

export type TerminalSession = z.infer<typeof TerminalSessionSchema>;

export function fetchTerminalSessions(
  clerkToken: string,
  computerGatewayUrl: string,
): Promise<TerminalSession[]> {
  let url: string;
  try {
    url = buildGatewayRequestUrl(computerGatewayUrl, "/api/terminal/sessions");
  } catch {
    return Promise.reject(new Error(TERMINALS_UNAVAILABLE_ERROR));
  }

  return fetchAuthenticatedJson({
    url,
    token: clerkToken,
    schema: TerminalSessionsResponseSchema,
    errorMessage: TERMINALS_UNAVAILABLE_ERROR,
  }).then((response) => response.sessions);
}

export function isValidEditableTerminalSessionName(value: string): boolean {
  return EDITABLE_TERMINAL_SESSION_NAME.test(value);
}

export async function renameTerminalSession(
  clerkToken: string,
  computerGatewayUrl: string,
  currentName: string,
  nextName: string,
): Promise<void> {
  if (!TERMINAL_SESSION_NAME.test(currentName) || !isValidEditableTerminalSessionName(nextName)) {
    throw new Error(TERMINAL_RENAME_ERROR);
  }
  let url: string;
  try {
    url = buildGatewayRequestUrl(
      computerGatewayUrl,
      `/api/terminal/sessions/${encodeURIComponent(currentName)}/rename`,
    );
  } catch {
    throw new Error(TERMINAL_RENAME_ERROR);
  }
  await fetchAuthenticatedJson({
    url,
    token: clerkToken,
    schema: TerminalRenameResponseSchema,
    errorMessage: TERMINAL_RENAME_ERROR,
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: nextName }),
  });
}

export async function deleteTerminalSession(
  clerkToken: string,
  computerGatewayUrl: string,
  name: string,
): Promise<void> {
  if (!TERMINAL_SESSION_NAME.test(name)) throw new Error(TERMINAL_DELETE_ERROR);
  let url: string;
  try {
    url = buildGatewayRequestUrl(
      computerGatewayUrl,
      `/api/terminal/sessions/${encodeURIComponent(name)}`,
      { force: "1" },
    );
  } catch {
    throw new Error(TERMINAL_DELETE_ERROR);
  }
  await fetchAuthenticatedJson({
    url,
    token: clerkToken,
    schema: TerminalDeleteResponseSchema,
    errorMessage: TERMINAL_DELETE_ERROR,
    method: "DELETE",
  });
}
