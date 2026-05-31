export const CLI_OUTPUT_VERSION = 1;

const GENERIC_MESSAGES: Record<string, string> = {
  zellij_failed: "Request failed",
  unknown_command: "Request failed",
  unsupported_version: "Request failed",
  auth_expired: "Matrix CLI auth expired. Run `matrix login` to refresh your session.",
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

export function formatNdjsonEvent(
  type: string,
  data: Record<string, unknown>,
): string {
  return `${JSON.stringify({ v: CLI_OUTPUT_VERSION, type, data })}\n`;
}
