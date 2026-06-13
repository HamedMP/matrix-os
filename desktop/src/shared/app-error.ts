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

  constructor(category: AppErrorCategory, options?: { cause?: unknown }) {
    // The message is always the generic copy — the cause stays internal.
    super(CATEGORY_MESSAGES[category], options);
    this.name = "AppError";
    this.category = category;
  }
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
