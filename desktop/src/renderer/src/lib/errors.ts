// Display boundary for all user-facing errors (FR-080, CLAUDE.md client-store
// rule). Unknown, long, or provider/path/database-looking strings are replaced
// with generic copy here even if upstream normalization regresses.
import { AppError, categoryMessage } from "../../../shared/app-error";

export { AppError } from "../../../shared/app-error";
export type { AppErrorCategory } from "../../../shared/app-error";

const MAX_SERVER_MESSAGE_LENGTH = 300;

// Markers that indicate a raw upstream error leaked: filesystem paths, syscall
// codes, database/provider names, stack traces (092 prototype rule).
const FORBIDDEN_MARKERS = [
  "/home/",
  "/users/",
  "/opt/",
  "enoent",
  "econn",
  "stack",
  "postgres",
  "sql",
  "traceback",
];

export function sanitizeServerMessage(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_SERVER_MESSAGE_LENGTH) return null;
  const lower = trimmed.toLowerCase();
  if (FORBIDDEN_MARKERS.some((marker) => lower.includes(marker))) return null;
  return trimmed;
}

export function toUserMessage(err: unknown): string {
  if (err instanceof AppError) return categoryMessage(err.category);
  return categoryMessage("server");
}
