import { normalizeLeadingGlobalFlags } from "../../sync-client/src/cli/global-flags.js";

export { normalizeLeadingGlobalFlags } from "../../sync-client/src/cli/global-flags.js";

export const PUBLISHED_CLI_COMMANDS = new Set([
  "login",
  "logout",
  "sync",
  "peers",
  "shell",
  "sh",
  "profile",
  "whoami",
  "status",
  "run",
  "doctor",
  "instance",
  "completion",
]);

export function resolvePublishedCliRedirect(argv: string[]): string[] | null {
  const normalized = normalizeLeadingGlobalFlags(argv);
  const first = normalized.find((arg) => !arg.startsWith("-"));
  if (!first || !PUBLISHED_CLI_COMMANDS.has(first)) {
    return null;
  }
  return normalized;
}
