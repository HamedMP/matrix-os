import { MessageBoardErrorBodySchema } from "@matrix-os/contracts/message-board";
import type { TerminalCaller } from "./terminal-agent-client.js";

const DEFAULT_TIMEOUT_MS = 10_000;
/** Header naming the Matrix terminal pane a loopback board call comes from (`<session>:<pane>`). */
export const TERMINAL_CALLER_HEADER = "x-matrix-terminal-caller";

/** A board failure safe to show: `reason` is stable, `message` is the board's own short copy. */
export class BoardCliError extends Error {
  readonly reason: string;
  readonly next?: string;
  readonly extra?: Record<string, unknown>;
  constructor(reason: string, message: string, options: { next?: string; extra?: Record<string, unknown> } = {}) {
    super(message);
    this.name = "BoardCliError";
    this.reason = reason;
    if (options.next) this.next = options.next;
    if (options.extra) this.extra = options.extra;
  }
}

const CLIENT_COPY: Record<string, string> = {
  gateway_unreachable: "Could not reach your Matrix OS computer.",
  request_timeout: "The message board did not answer in time.",
  interrupted: "Interrupted.",
  auth_expired: "Matrix CLI auth expired. Run `matrix login` to refresh your session.",
  request_failed: "The message board request failed.",
  invalid_response: "The message board sent an unexpected response.",
};

export function boardClientError(reason: keyof typeof CLIENT_COPY | string, next?: string): BoardCliError {
  return new BoardCliError(reason, CLIENT_COPY[reason] ?? CLIENT_COPY.request_failed!, next ? { next } : {});
}

export interface BoardRequest {
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  timeoutMs?: number;
  /** Aborts the request early (Ctrl-C); the timeout still applies. */
  signal?: AbortSignal;
}

export interface BoardClient {
  readonly board?: string;
  request(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, init?: BoardRequest): Promise<Record<string, unknown>>;
}

/** HTTP client for `/api/board/*`. Every request has a timeout; errors carry only the board's reason and copy. */
export function createBoardClient(options: {
  gatewayUrl: string;
  token: string;
  board?: string;
  caller?: TerminalCaller;
  fetch?: typeof fetch;
}): BoardClient {
  const fetchImpl = options.fetch ?? fetch;
  const base = `${options.gatewayUrl.replace(/\/+$/, "")}/api/board`;

  async function request(method: string, path: string, init: BoardRequest = {}) {
    const url = new URL(`${base}${path}`);
    const query = { ...init.query, ...(options.board ? { board: options.board } : {}) };
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const timeout = AbortSignal.timeout(init.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetchImpl(url.toString(), {
        method,
        headers: {
          Authorization: `Bearer ${options.token}`,
          ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...(options.caller ? { [TERMINAL_CALLER_HEADER]: `${options.caller.sessionName}:${options.caller.paneId}` } : {}),
        },
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
        redirect: "error",
        signal: init.signal ? AbortSignal.any([timeout, init.signal]) : timeout,
      });
    } catch (error: unknown) {
      if (init.signal?.aborted) throw boardClientError("interrupted");
      const timedOut = error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError");
      throw boardClientError(timedOut ? "request_timeout" : "gateway_unreachable");
    }
    let payload: unknown = {};
    try {
      payload = await response.json();
    } catch (error: unknown) {
      if (!(error instanceof SyntaxError)) throw boardClientError(init.signal?.aborted ? "interrupted" : "gateway_unreachable");
    }
    if (!response.ok) {
      const parsed = MessageBoardErrorBodySchema.safeParse(payload);
      if (parsed.success) {
        throw new BoardCliError(parsed.data.reason, parsed.data.error, parsed.data.next ? { next: parsed.data.next } : {});
      }
      throw boardClientError(response.status === 401 ? "auth_expired" : "request_failed");
    }
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) throw boardClientError("invalid_response");
    return payload as Record<string, unknown>;
  }

  return { ...(options.board ? { board: options.board } : {}), request };
}
