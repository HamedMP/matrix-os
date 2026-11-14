import type { TerminalRef } from "./shell-client.js";

const DEFAULT_TIMEOUT_MS = 10_000;
// A send may hold for up to 60 s while a person finishes typing.
const SEND_TIMEOUT_MS = 90_000;
const SAFE_SERVER_CODES = new Set(["terminal_agent_blocked", "terminal_finished"]);

export interface TerminalReadOutput {
  screen: string;
  history: string;
  lines: number;
  updatedAt?: string;
  incomplete?: boolean;
  why?: string;
}

export interface TerminalAgentClient {
  get(ref: TerminalRef): Promise<Record<string, unknown>>;
  read(ref: TerminalRef, lines: number): Promise<TerminalReadOutput>;
  send(ref: TerminalRef, input: { text: string; force?: boolean }): Promise<{ sent: boolean; heldMs: number }>;
  keys(ref: TerminalRef, keys: string[]): Promise<{ pressed: number }>;
  interrupt(ref: TerminalRef): Promise<TerminalInterruptOutput>;
}

/** What changed within five seconds of the stop key; null when nothing did. */
export type TerminalInterruptObserved = { status: string } | { exited: true; exitCode?: number } | null;

export interface TerminalInterruptOutput {
  pressed: string;
  observed: TerminalInterruptObserved;
}

function interruptObserved(value: unknown): TerminalInterruptObserved {
  if (!value || typeof value !== "object") return null;
  const observed = value as Record<string, unknown>;
  if (observed.exited === true) {
    return { exited: true, ...(Number.isInteger(observed.exitCode) ? { exitCode: observed.exitCode as number } : {}) };
  }
  return typeof observed.status === "string" && /^[a-z]{1,16}$/.test(observed.status) ? { status: observed.status } : null;
}

/** HTTP client for the gateway's Herdr-style terminal verbs. */
export function createTerminalAgentClient(options: {
  gatewayUrl: string;
  token: string;
  fetch?: typeof fetch;
}): TerminalAgentClient {
  const fetchImpl = options.fetch ?? fetch;
  const base = options.gatewayUrl.replace(/\/+$/, "");
  const tabPath = (ref: TerminalRef) =>
    `/api/terminal/workspaces/${encodeURIComponent(ref.workspaceId)}/tabs/${encodeURIComponent(ref.tabId)}`;

  async function request(path: string, init: { method?: string; body?: unknown } = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
    let response: Response;
    try {
      response = await fetchImpl(`${base}${path}`, {
        method: init.method ?? "GET",
        headers: {
          Authorization: `Bearer ${options.token}`,
          ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err: unknown) {
      const timedOut = err instanceof DOMException && (err.name === "AbortError" || err.name === "TimeoutError");
      throw Object.assign(new Error("Request failed"), { code: timedOut ? "request_timeout" : "gateway_unreachable" });
    }
    let payload: unknown = {};
    try { payload = await response.json(); }
    catch (err: unknown) { if (!(err instanceof SyntaxError)) throw err; }
    if (!response.ok) {
      const serverCode = typeof payload === "object" && payload !== null
        && typeof (payload as { error?: unknown }).error === "string"
        ? (payload as { error: string }).error
        : undefined;
      const code = serverCode && SAFE_SERVER_CODES.has(serverCode)
        ? serverCode
        : response.status === 401 ? "auth_expired"
          : response.status === 404 ? "not_found"
            : "request_failed";
      throw Object.assign(new Error("Request failed"), { code });
    }
    if (typeof payload !== "object" || payload === null) {
      throw Object.assign(new Error("Request failed"), { code: "invalid_response" });
    }
    return payload as Record<string, unknown>;
  }

  return {
    get: (ref) => request(tabPath(ref)),
    async read(ref, lines) {
      const payload = await request(`${tabPath(ref)}/read?lines=${encodeURIComponent(String(lines))}`);
      return {
        screen: typeof payload.screen === "string" ? payload.screen : "",
        history: typeof payload.history === "string" ? payload.history : "",
        lines: typeof payload.lines === "number" ? payload.lines : 0,
        ...(typeof payload.updatedAt === "string" ? { updatedAt: payload.updatedAt } : {}),
        ...(payload.incomplete === true ? { incomplete: true } : {}),
        ...(typeof payload.why === "string" ? { why: payload.why } : {}),
      };
    },
    async send(ref, input) {
      const payload = await request(`${tabPath(ref)}/send`, { method: "POST", body: input }, SEND_TIMEOUT_MS);
      return { sent: payload.sent === true, heldMs: typeof payload.heldMs === "number" ? payload.heldMs : 0 };
    },
    async keys(ref, keys) {
      const payload = await request(`${tabPath(ref)}/keys`, { method: "POST", body: { keys } });
      return { pressed: typeof payload.pressed === "number" ? payload.pressed : 0 };
    },
    async interrupt(ref) {
      const payload = await request(`${tabPath(ref)}/interrupt`, { method: "POST", body: {} });
      return { pressed: typeof payload.pressed === "string" ? payload.pressed : "", observed: interruptObserved(payload.observed) };
    },
  };
}
