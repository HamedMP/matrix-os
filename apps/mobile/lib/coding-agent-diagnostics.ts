const MAX_DIAGNOSTIC_MESSAGE_LENGTH = 180;
const MAX_DIAGNOSTIC_NAME_LENGTH = 48;

export interface MobileCodingAgentDiagnostic {
  name: string;
  message: string;
}

export interface MobileCodingAgentDiagnosticLogger {
  warn(message: string, diagnostic?: MobileCodingAgentDiagnostic): void;
}

const URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi;
const BEARER_PATTERN = /\b(?:Authorization\s*:\s*)?Bearer\s+[A-Za-z0-9._~+/=-]+/gi;
const SECRET_ASSIGNMENT_PATTERN = /\b(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|passwd|secret)\s*[:=]\s*[^\s"'<>]+/gi;
const KNOWN_SECRET_PREFIX_PATTERN = /\b(?:sk|sk_live|sk_test|ghp|github_pat|xoxb|xoxp|xoxa|xoxr|glpat|hf)[_-][A-Za-z0-9._-]{4,}\b/gi;
const OWNER_PATH_PATTERN = /(?:^|[\s"'(:])(?:\/(?:home|Users|private|tmp|var|opt|etc|root|run)\/[^\s"'<>)]*)/g;
const WINDOWS_PATH_PATTERN = /\b[A-Za-z]:\\[^\s"'<>)]*/g;
const PRIVATE_IPV4_PATTERN = /\b(?:(?:10|127)\.\d{1,3}\.\d{1,3}\.\d{1,3}|169\.254\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})\b/g;
const HOST_VALUE_PATTERN = /\b(?:host|hostname|url)\s*[:=]?\s*[A-Za-z0-9.-]*(?:\.local|\.internal|\.lan|\.home|runtime|matrix|vps)[A-Za-z0-9.-]*/gi;
const DATABASE_PATTERN = /\b(?:postgres(?:ql)?|kysely|database|db)\b/gi;

function normalize(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function cap(value: string): string {
  if (value.length <= MAX_DIAGNOSTIC_MESSAGE_LENGTH) return value;
  return `${value.slice(0, MAX_DIAGNOSTIC_MESSAGE_LENGTH - 3)}...`;
}

export function redactMobileCodingAgentDiagnosticText(value: unknown): string {
  const raw = normalize(typeof value === "string" ? value : String(value));
  if (!raw) return "unavailable";
  const redacted = raw
    .replace(URL_PATTERN, "[url]")
    .replace(BEARER_PATTERN, (match) => (match.match(/^Authorization\s*:/i) ? "Authorization: [token]" : "Bearer [token]"))
    .replace(SECRET_ASSIGNMENT_PATTERN, (match) => {
      const separator = match.includes(":") ? ":" : "=";
      const key = match.split(separator)[0]?.trim() || "token";
      return `${key}${separator} [token]`;
    })
    .replace(KNOWN_SECRET_PREFIX_PATTERN, "[token]")
    .replace(OWNER_PATH_PATTERN, (match) => `${match[0] === "/" ? "" : match[0]}[path]`)
    .replace(WINDOWS_PATH_PATTERN, "[path]")
    .replace(PRIVATE_IPV4_PATTERN, "[host]")
    .replace(HOST_VALUE_PATTERN, (match) => {
      const prefix = match.match(/^(host|hostname|url)\s*[:=]?/i)?.[0] ?? "host ";
      return `${prefix}[host]`;
    })
    .replace(DATABASE_PATTERN, "[database]");
  return cap(normalize(redacted) || "unavailable");
}

function safeDiagnosticName(value: string): string {
  return redactMobileCodingAgentDiagnosticText(value)
    .replace(/[^A-Za-z0-9_.-]/g, "")
    .slice(0, MAX_DIAGNOSTIC_NAME_LENGTH) || "Error";
}

export function formatMobileCodingAgentDiagnostic(err: unknown): MobileCodingAgentDiagnostic {
  if (err instanceof Error) {
    return {
      name: safeDiagnosticName(err.name || "Error"),
      message: redactMobileCodingAgentDiagnosticText(err.message),
    };
  }
  return {
    name: "Unknown",
    message: redactMobileCodingAgentDiagnosticText(err),
  };
}

export function logMobileCodingAgentWarning(
  scope: string,
  err: unknown,
  logger: MobileCodingAgentDiagnosticLogger = console,
): void {
  // The helper is exported for mobile clients, so scope labels are redacted too.
  logger.warn(`[mobile] ${redactMobileCodingAgentDiagnosticText(scope)}`, formatMobileCodingAgentDiagnostic(err));
}
