export const PUBLISHED_CLI_COMMANDS = new Set([
  "login",
  "logout",
  "sync",
  "peers",
  "keys",
  "ssh",
  "shell",
  "sh",
  "profile",
  "whoami",
  "status",
  "doctor",
  "instance",
  "completion",
]);

export function resolvePublishedCliRedirect(argv: string[]): string[] | null {
  const first = argv.find((arg) => !arg.startsWith("-"));
  if (!first || !PUBLISHED_CLI_COMMANDS.has(first)) {
    return null;
  }
  return argv;
}
