const MAX_DIAGNOSTIC_MESSAGE_LENGTH = 180;
const MAX_DIAGNOSTIC_NAME_LENGTH = 48;

export interface CodingAgentDiagnosticLogger {
  warn(message: string, diagnostic?: CodingAgentDiagnostic): void;
}

export interface CodingAgentDiagnostic {
  name: string;
  message: string;
}

const URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const AUTHORIZATION_ASSIGNMENT_PATTERN = /\b(authorization)(\s*[:=]\s*)(?:"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|[A-Za-z][A-Za-z0-9._-]{0,31}\s+[^\s"'<>]+|[^\s"'<>]+)/gi;
const ASSIGNMENT_PATTERN = /\b([A-Za-z][A-Za-z0-9_-]{0,127})(\s*[:=]\s*)(?:(?:Basic|Bearer|Digest)\s+[^\s"'<>]+|"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|[^\s"'<>]+)/gi;
const KNOWN_SECRET_PREFIX_PATTERN = /\b(?:sk|sk_live|sk_test|ghp|github_pat|xoxb|xoxp|xoxa|xoxr|glpat|hf)[_-][A-Za-z0-9._-]{4,}\b/gi;
const OWNER_PATH_PATTERN = /(?:^|[\s"'(:])(?:\/(?:home|Users|private|tmp|var|opt|etc|root|run)\/[^\s"'<>)]*)/g;
const WINDOWS_PATH_PATTERN = /\b[A-Za-z]:\\[^\s"'<>)]*/g;
const PRIVATE_IPV4_PATTERN = /\b(?:(?:10|127)\.\d{1,3}\.\d{1,3}\.\d{1,3}|169\.254\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})\b/g;
const PRIVATE_IPV6_PATTERN = /(?<![A-Fa-f0-9:])(?:::1|(?:f[cd][A-Fa-f0-9]{2}|fe[89ab][A-Fa-f0-9])(?::[A-Fa-f0-9]{0,4}){1,7})(?:%[A-Za-z0-9_.-]+)?(?![A-Fa-f0-9:])/gi;
const PRIVATE_HOSTNAME_PATTERN = /\b(?:(?=[A-Za-z0-9.-]{1,253}\b)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,62})?\.)+(?:local|internal|lan|home|localhost)|localhost)\b/gi;
const HOST_VALUE_PATTERN = /\b(?:host|hostname)\s*[:=]?\s*[A-Za-z0-9.-]*(?:\.local|\.internal|\.lan|\.home|runtime|matrix|vps)[A-Za-z0-9.-]*/gi;
const DATABASE_PATTERN = /\b(?:postgres(?:ql)?|kysely|database|db)\b/gi;

function capDiagnosticText(value: string): string {
  if (value.length <= MAX_DIAGNOSTIC_MESSAGE_LENGTH) return value;
  return `${value.slice(0, MAX_DIAGNOSTIC_MESSAGE_LENGTH - 3)}...`;
}

function normalizeDiagnosticText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function isSecretAssignmentKey(key: string): boolean {
  const segments = key.toLowerCase().split(/[_-]+/);
  if (segments.some((segment) => ["authorization", "credential", "credentials", "passwd", "password", "secret", "token"].includes(segment))) {
    return true;
  }

  const flattened = segments.join("");
  if (["apikey", "accesstoken", "authtoken", "pgpassword", "refreshtoken"].includes(flattened)) {
    return true;
  }

  return segments.some(
    (segment, index) => ["access", "api", "private"].includes(segment) && segments[index + 1] === "key",
  );
}

export function redactCodingAgentDiagnosticText(value: unknown): string {
  const raw = normalizeDiagnosticText(typeof value === "string" ? value : String(value));
  if (!raw) return "unavailable";
  const redacted = raw
    .replace(URL_PATTERN, "[url]")
    .replace(BEARER_PATTERN, "Bearer [token]")
    .replace(AUTHORIZATION_ASSIGNMENT_PATTERN, (_match, key: string, separator: string) => {
      return `${key}${separator.trim()} [token]`;
    })
    .replace(ASSIGNMENT_PATTERN, (match, key: string, separator: string) => {
      if (!isSecretAssignmentKey(key)) return match;
      return `${key}${separator.trim()} [token]`;
    })
    .replace(KNOWN_SECRET_PREFIX_PATTERN, "[token]")
    .replace(OWNER_PATH_PATTERN, (match) => `${match[0] === "/" ? "" : match[0]}[path]`)
    .replace(WINDOWS_PATH_PATTERN, "[path]")
    .replace(PRIVATE_IPV4_PATTERN, "[host]")
    .replace(PRIVATE_IPV6_PATTERN, "[host]")
    .replace(PRIVATE_HOSTNAME_PATTERN, "[host]")
    .replace(HOST_VALUE_PATTERN, (match) => {
      const prefix = match.match(/^(host|hostname)\s*[:=]?/i)?.[0] ?? "host ";
      return `${prefix}[host]`;
    })
    .replace(DATABASE_PATTERN, "[database]");
  return capDiagnosticText(normalizeDiagnosticText(redacted) || "unavailable");
}

function safeDiagnosticName(name: string): string {
  const normalized = name.replace(/[^A-Za-z0-9_.-]/g, "").slice(0, MAX_DIAGNOSTIC_NAME_LENGTH);
  return normalized || "Error";
}

function safeDiagnosticScope(scope: string): string {
  return capDiagnosticText(normalizeDiagnosticText(scope) || "warning");
}

export function formatCodingAgentDiagnostic(err: unknown): CodingAgentDiagnostic {
  if (err instanceof Error) {
    return {
      name: safeDiagnosticName(err.name || "Error"),
      message: redactCodingAgentDiagnosticText(err.message),
    };
  }
  return {
    name: "Unknown",
    message: redactCodingAgentDiagnosticText(err),
  };
}

export function logCodingAgentWarning(
  scope: string,
  err: unknown,
  logger: CodingAgentDiagnosticLogger = console,
): void {
  logger.warn(`[coding-agents] ${safeDiagnosticScope(scope)}`, formatCodingAgentDiagnostic(err));
}
