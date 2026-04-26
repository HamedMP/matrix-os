export const CLI_OUTPUT_VERSION = 1;

const GENERIC_MESSAGES: Record<string, string> = {
  zellij_failed: "Request failed",
  unknown_command: "Request failed",
  unsupported_version: "Request failed",
};

export function formatCliSuccess(data: Record<string, unknown>): string {
  return JSON.stringify({ v: CLI_OUTPUT_VERSION, ok: true, data });
}

export function formatCliError(code: string, message?: string): string {
  return JSON.stringify({
    v: CLI_OUTPUT_VERSION,
    error: {
      code,
      message: message ?? GENERIC_MESSAGES[code] ?? "Request failed",
    },
  });
}

export function formatNdjsonEvent(
  type: string,
  data: Record<string, unknown>,
): string {
  return `${JSON.stringify({ v: CLI_OUTPUT_VERSION, type, data })}\n`;
}
