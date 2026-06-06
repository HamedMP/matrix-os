export const CLI_OUTPUT_VERSION = 1;

const GENERIC_MESSAGES: Record<string, string> = {
  platform_unreachable: "Platform unreachable. Matrix CLI could not contact the Matrix OS platform.",
  gateway_unreachable: "Gateway unreachable. Matrix CLI could not contact your Matrix OS instance.",
  request_timeout: "Request timed out. Try again or run `mos doctor`.",
  zellij_failed: "Shell backend unavailable. Your Matrix OS instance could not start a shell session.",
  unsupported_node: "Matrix CLI requires Node.js 24 or newer.",
  attach_failed: "Shell attach failed.",
  unknown_command: "Request failed",
  unsupported_version: "Request failed",
  auth_expired: "Matrix CLI auth expired. Run `mos login` to refresh your session.",
};

export function formatCliSuccess(data: Record<string, unknown>): string {
  return JSON.stringify({ v: CLI_OUTPUT_VERSION, ok: true, data });
}

export function formatCliErrorMessage(code: string, message?: string): string {
  return message ?? GENERIC_MESSAGES[code] ?? "Request failed";
}

export function formatCliError(code: string, message?: string): string {
  return JSON.stringify({
    v: CLI_OUTPUT_VERSION,
    error: {
      code,
      message: formatCliErrorMessage(code, message),
    },
  });
}

export function cliError(code: string, message?: string): Error & { code: string } {
  return Object.assign(new Error(message ?? "Request failed"), { code });
}

export function safeCliErrorCode(err: unknown, fallback = "request_failed"): string {
  return err instanceof Error && "code" in err && typeof (err as { code?: unknown }).code === "string"
    ? (err as { code: string }).code
    : fallback;
}

export function isFetchTimeoutError(err: unknown): boolean {
  return err instanceof DOMException && (err.name === "AbortError" || err.name === "TimeoutError");
}

export function isFetchNetworkError(err: unknown): boolean {
  return err instanceof TypeError;
}

export function cliFetchError(
  err: unknown,
  codes: { timeout: string; network: string; fallback?: string },
): Error & { code: string } {
  if (isFetchTimeoutError(err)) {
    return cliError(codes.timeout);
  }
  if (isFetchNetworkError(err)) {
    return cliError(codes.network);
  }
  return cliError(codes.fallback ?? codes.network);
}

export function formatNdjsonEvent(
  type: string,
  data: Record<string, unknown>,
): string {
  return `${JSON.stringify({ v: CLI_OUTPUT_VERSION, type, data })}\n`;
}
