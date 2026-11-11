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
  /** One server-side wait of at most 90 s; callers loop for longer waits. */
  wait(ref: TerminalRef, input: { output?: string; seen?: number; timeoutMs: number }): Promise<TerminalWaitOutput>;
  templates(): Promise<Array<{ name: string; description: string }>>;
  run(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  label(ref: TerminalRef, input: { set?: Record<string, string>; remove?: string[] }): Promise<Record<string, unknown>>;
  report(input: { caller: TerminalCaller; text: string }): Promise<Record<string, unknown>>;
  waitChildren(input: { caller: TerminalCaller; mode: "any" | "all"; timeoutMs: number }): Promise<TerminalWaitOutput>;
}

export interface TerminalCaller { sessionName: string; paneId: string }

/** The Matrix terminal this process runs in, from zellij's pane environment. */
export function terminalCallerFromEnv(env: NodeJS.ProcessEnv = process.env): TerminalCaller | undefined {
  const sessionName = env.ZELLIJ_SESSION_NAME ?? "";
  const paneId = env.ZELLIJ_PANE_ID ?? "";
  return /^matrix-(?:w-|rt_)[0-9a-f]{32}$/.test(sessionName) && /^[0-9]{1,9}$/.test(paneId) ? { sessionName, paneId } : undefined;
}

/** What changed within five seconds of the stop key; null when nothing did. */
export type TerminalInterruptObserved = { status: string } | { exited: true; exitCode?: number } | null;

// A type alias, so the CLI can print it as a plain record.
export type TerminalInterruptOutput = {
  pressed: string;
  observed: TerminalInterruptObserved;
};

function interruptObserved(value: unknown): TerminalInterruptObserved {
  if (!value || typeof value !== "object") return null;
  const observed = value as Record<string, unknown>;
  if (observed.exited === true) {
    return { exited: true, ...(Number.isInteger(observed.exitCode) ? { exitCode: observed.exitCode as number } : {}) };
  }
  return typeof observed.status === "string" && /^[a-z]{1,16}$/.test(observed.status) ? { status: observed.status } : null;
}

export interface TerminalWaitOutput {
  reason: string;
  status?: string;
  exitCode?: number | null;
  child?: TerminalRef;
  /** How often the awaited output had appeared; passed back so one wait keeps one baseline. */
  seen?: number;
}

export const TERMINAL_WAIT_REQUEST_MAX_MS = 90_000;

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
    async wait(ref, input) {
      const timeoutMs = Math.min(Math.max(0, Math.floor(input.timeoutMs)), TERMINAL_WAIT_REQUEST_MAX_MS);
      const payload = await request(`${tabPath(ref)}/wait`, {
        method: "POST",
        body: { timeoutMs, ...(input.output ? { output: input.output } : {}), ...(input.seen !== undefined ? { seen: input.seen } : {}) },
      }, timeoutMs + 15_000);
      return {
        reason: typeof payload.reason === "string" ? payload.reason : "unknown",
        ...(typeof payload.status === "string" ? { status: payload.status } : {}),
        ...(typeof payload.exitCode === "number" || payload.exitCode === null ? { exitCode: payload.exitCode as number | null } : {}),
        ...(typeof payload.seen === "number" ? { seen: payload.seen } : {}),
      };
    },
    async templates() {
      const payload = await request("/api/terminal/templates");
      const templates = Array.isArray(payload.templates) ? payload.templates : [];
      return templates.flatMap((entry: unknown) => {
        if (!entry || typeof entry !== "object") return [];
        const record = entry as Record<string, unknown>;
        return typeof record.name === "string"
          ? [{ name: record.name, description: typeof record.description === "string" ? record.description : "" }]
          : [];
      });
    },
    // Template launches wait up to 60 s for the agent to be ready for its first message.
    run: (input) => request("/api/terminal/agents/run", { method: "POST", body: input }, SEND_TIMEOUT_MS),
    label: (ref, input) => request(`${tabPath(ref)}/labels`, { method: "PATCH", body: input }),
    report: (input) => request("/api/terminal/agents/report", { method: "POST", body: input }, SEND_TIMEOUT_MS),
    async waitChildren(input) {
      const timeoutMs = Math.min(Math.max(0, Math.floor(input.timeoutMs)), TERMINAL_WAIT_REQUEST_MAX_MS);
      const payload = await request("/api/terminal/agents/wait-children", {
        method: "POST", body: { caller: input.caller, mode: input.mode, timeoutMs },
      }, timeoutMs + 15_000);
      return {
        reason: typeof payload.reason === "string" ? payload.reason : "unknown",
        ...(typeof payload.status === "string" ? { status: payload.status } : {}),
        ...(payload.child && typeof payload.child === "object" ? { child: payload.child as TerminalRef } : {}),
      };
    },
    async interrupt(ref) {
      const payload = await request(`${tabPath(ref)}/interrupt`, { method: "POST", body: {} });
      return { pressed: typeof payload.pressed === "string" ? payload.pressed : "", observed: interruptObserved(payload.observed) };
    },
  };
}
