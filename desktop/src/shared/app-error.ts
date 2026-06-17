// One error taxonomy for the whole app (FR-080). Categories cross the IPC
// boundary; raw error text never does.

export type AppErrorCategory =
  | "unauthorized"
  | "offline"
  | "timeout"
  | "notFound"
  | "server"
  | "misconfigured"
  | "fatalSession";

const CATEGORY_MESSAGES: Record<AppErrorCategory, string> = {
  unauthorized: "Your session has expired. Please sign in again.",
  offline: "Can't reach Matrix OS. Check your connection.",
  timeout: "The request timed out. Please try again.",
  notFound: "That item could not be found.",
  server: "Something went wrong. Please try again.",
  misconfigured: "No computer is connected. Select a runtime to continue.",
  fatalSession: "This session has ended.",
};

export class AppError extends Error {
  readonly category: AppErrorCategory;
  // An optional safe, app-level reason CODE from the gateway (e.g.
  // "invalid_session_request", "not_found"). Never a raw provider/DB/path
  // string — only short slugs the gateway emits as { error: { code } }.
  readonly detail?: string;

  constructor(category: AppErrorCategory, options?: { cause?: unknown; detail?: string }) {
    // The message is always the generic copy — the cause stays internal.
    super(CATEGORY_MESSAGES[category], options);
    this.name = "AppError";
    this.category = category;
    if (options?.detail) this.detail = options.detail;
  }
}

// Gateway error codes are short lower_snake slugs; anything else (provider
// names, paths, long strings) is rejected so it never reaches the UI.
export function safeErrorDetail(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return /^[a-z][a-z0-9_]{2,48}$/.test(value) ? value : undefined;
}

export function categoryMessage(category: AppErrorCategory): string {
  return CATEGORY_MESSAGES[category];
}

export function classifyHttpStatus(status: number): AppErrorCategory {
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 404) return "notFound";
  return "server";
}

export function classifyTransportError(err: unknown): AppErrorCategory {
  if (err instanceof DOMException && (err.name === "TimeoutError" || err.name === "AbortError")) {
    return "timeout";
  }
  if (err instanceof TypeError) return "offline";
  return "server";
}
