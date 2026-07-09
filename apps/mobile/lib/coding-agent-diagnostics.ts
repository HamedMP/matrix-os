const MAX_DIAGNOSTIC_INPUT_LENGTH = 4_096;
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
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const AUTHORIZATION_ASSIGNMENT_PATTERN = /\b(authorization)(\s*[:=]\s*)[^\r\n]+/gi;
const ASSIGNMENT_PATTERN = /\b([A-Za-z][A-Za-z0-9_-]{0,127})(\s*[:=]\s*)(?:(?:Basic|Bearer|Digest)\s+[^\s"'<>]+|"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|[^\s"'<>]+)/gi;
const KNOWN_SECRET_PREFIX_PATTERN = /\b(?:sk|sk_live|sk_test|ghp|github_pat|xoxb|xoxp|xoxa|xoxr|glpat|hf)[_-][A-Za-z0-9._-]{4,}\b/gi;
const OWNER_PATH_PATTERN = /(?:^|[\s"'`(:=])(?:\/(?:home|Users|private|tmp|var|opt|etc|root|run)\/[^\s"'`<>)]*)/g;
const WINDOWS_PATH_PATTERN = /\b[A-Za-z]:\\[^\s"'`<>)]*/g;
const PRIVATE_IPV4_PATTERN = /\b(?:(?:10|127)\.\d{1,3}\.\d{1,3}\.\d{1,3}|169\.254\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})\b/g;
const PRIVATE_IPV6_PATTERN = /(^|[^A-Fa-f0-9:])(?:::1|(?:f[cd][A-Fa-f0-9]{2}|fe[89ab][A-Fa-f0-9])(?::[A-Fa-f0-9]{0,4}){1,7})(?:%[A-Za-z0-9_.-]+)?(?=$|[^A-Fa-f0-9:])/gi;
const PRIVATE_HOSTNAME_PATTERN = /\b(?:(?=[A-Za-z0-9.-]{1,253}\b)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,62})?\.)+(?:local|internal|lan|home|localhost)|localhost)\b/gi;
const NETWORK_ERROR_SINGLE_LABEL_HOST_PATTERN = /\b((?:ENOTFOUND|EAI_AGAIN|ECONNREFUSED|EHOSTUNREACH|ETIMEDOUT)\s+)(?=[A-Za-z0-9-]{1,63}(?![A-Za-z0-9.-]))(?=[A-Za-z0-9-]*[A-Za-z])[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?![A-Za-z0-9.-])/gi;
const HOST_VALUE_PATTERN = /\b(hostname|host|url)(\s*[:=]\s*|\s+)(?:"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|[^\s"'<>]+)/gi;
const DATABASE_PATTERN = /\b(?:postgres(?:ql)?|kysely|database|db)\b/gi;

function normalize(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function cap(value: string): string {
  if (value.length <= MAX_DIAGNOSTIC_MESSAGE_LENGTH) return value;
  return `${value.slice(0, MAX_DIAGNOSTIC_MESSAGE_LENGTH - 3)}...`;
}

function isSecretAssignmentKey(key: string): boolean {
  const segments = key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase()
    .split(/[_-]+/);
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

export function redactMobileCodingAgentDiagnosticText(value: unknown): string {
  const input = (typeof value === "string" ? value : String(value)).slice(0, MAX_DIAGNOSTIC_INPUT_LENGTH);
  if (!normalize(input)) return "unavailable";
  const redacted = input
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
    .replace(PRIVATE_IPV6_PATTERN, (_match, prefix: string) => `${prefix}[host]`)
    .replace(PRIVATE_HOSTNAME_PATTERN, "[host]")
    .replace(NETWORK_ERROR_SINGLE_LABEL_HOST_PATTERN, "$1[host]")
    .replace(HOST_VALUE_PATTERN, (_match, key: string, separator: string) => {
      return `${key}${separator}[host]`;
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
