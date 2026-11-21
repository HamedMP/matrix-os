// The "Herdr sessions" list for every OS view (spec 2701): one client over the
// gateway's `/api/terminal/herdr`, so Web Canvas, Web Desktop, Electron Desktop
// and the CLI derive the same group from the same response.
import {
  HERDR_TERMINAL_WORKSPACE_ID, HerdrSessionListSchema, shouldShowHerdrSessions,
  type HerdrSession, type HerdrSessionList,
} from "@matrix-os/contracts/herdr-terminals";

export const HERDR_SESSIONS_PATH = "/api/terminal/herdr";
const MAX_RESPONSE_CHARS = 512 * 1024;

/** An authenticated gateway request; each surface supplies its own transport. */
export type HerdrSessionsRequest = (path: string, init: { method: "GET" | "DELETE"; signal: AbortSignal }) => Promise<Response>;

export const HIDDEN_HERDR_SESSIONS: HerdrSessionList = { available: false, status: "unavailable", sessions: [] };

export class HerdrSessionsRequestError extends Error {
  constructor() { super("Herdr sessions are unavailable"); this.name = "HerdrSessionsRequestError"; }
}

/** The current list, or the hidden list when the gateway cannot say (no Herdr UI then). */
export async function loadHerdrSessions(request: HerdrSessionsRequest, timeoutMs = 10_000): Promise<HerdrSessionList> {
  const response = await request(HERDR_SESSIONS_PATH, { method: "GET", signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) return HIDDEN_HERDR_SESSIONS;
  const text = await response.text();
  if (text.length > MAX_RESPONSE_CHARS) return HIDDEN_HERDR_SESSIONS;
  let value: unknown;
  try { value = JSON.parse(text); }
  catch (error: unknown) {
    if (!(error instanceof SyntaxError)) throw error;
    return HIDDEN_HERDR_SESSIONS;
  }
  const parsed = HerdrSessionListSchema.safeParse(value);
  return parsed.success ? parsed.data : HIDDEN_HERDR_SESSIONS;
}

/** Ends a Herdr terminal. Throws a generic error; the caller keeps the row until this succeeds. */
export async function closeHerdrSession(request: HerdrSessionsRequest, id: string, timeoutMs = 10_000): Promise<void> {
  const response = await request(`${HERDR_SESSIONS_PATH}/${encodeURIComponent(id)}`, { method: "DELETE", signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new HerdrSessionsRequestError();
}

/** The terminal ref key (`workspaceId:tabId`) a Matrix terminal view opens for this Herdr session. */
export function herdrSessionRefKey(session: Pick<HerdrSession, "tabId">): string {
  return `${HERDR_TERMINAL_WORKSPACE_ID}:${session.tabId}`;
}

export { shouldShowHerdrSessions };
export type { HerdrSession, HerdrSessionList };
