export const CLI_OUTPUT_VERSION = 1;

const GENERIC_MESSAGES: Record<string, string> = {
  platform_unreachable: "Platform unreachable. Matrix CLI could not contact the Matrix OS platform.",
  gateway_unreachable: "Gateway unreachable. Matrix CLI could not contact your Matrix OS instance.",
  request_timeout: "Request timed out. Try again or run `mos doctor`.",
  zellij_failed: "Shell backend unavailable. Your Matrix OS instance could not start a shell session.",
  unsupported_node: "Matrix CLI requires Node.js 24 or newer.",
  attach_failed: "Shell attach failed.",
  attach_timeout: "Shell attach timed out. Try again or run `mos doctor`.",
  login_failed: "Login failed. Run `mos login` to retry.",
  shell_backend_unavailable: "Shell backend unavailable. Run `mos doctor` for diagnostics.",
  unknown_command: "Request failed",
  unsupported_version: "Request failed",
  auth_expired: "Matrix CLI auth expired. Run `mos login` to refresh your session.",
  billing_required: "Choose a plan before running setup. Visit https://app.matrix-os.com/?plans=1.",
  not_authenticated: "Not signed in. Run `mos login` first.",
  retry_exhausted: "Setup has failed repeatedly. Contact support@matrix-os.com.",
  setup_failed: "Couldn't start setup. Please try again shortly.",
  setup_timeout: "Setup is taking longer than expected. Re-run `mos login` shortly to check.",
  payment_delayed: "Payment is taking longer than expected to confirm. Contact support@matrix-os.com if it persists.",
};

export function formatCliSuccess(data: Record<string, unknown>): string {
  return JSON.stringify({ v: CLI_OUTPUT_VERSION, ok: true, data });
}

export function formatCliErrorMessage(code: string, message?: string): string {
  return message ?? GENERIC_MESSAGES[code] ?? "Request failed";
}

export function formatCliError(
  code: string,
  message?: string,
  details?: Record<string, unknown>,
): string {
  return JSON.stringify({
    v: CLI_OUTPUT_VERSION,
    error: {
      code,
      message: formatCliErrorMessage(code, message),
      ...details,
    },
  });
}

export function cliError(code: string, message?: string): Error & { code: string } {
  return Object.assign(new Error(message ?? "Request failed"), { code });
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
