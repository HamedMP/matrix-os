export type TuiLaunchMode =
  | { mode: "tui"; explicit: boolean }
  | { mode: "direct"; reason?: string }
  | { mode: "help"; reason: "non-interactive" };

const DIRECT_FLAGS = new Set(["--help", "-h", "help", "--version", "-v", "version", "--json"]);
const DIRECT_COMMANDS = new Set(["login", "logout", "sync", "peers", "shell", "sh", "profile", "whoami", "status", "run", "doctor", "instance", "completion"]);
const TUI_ONLY_FLAGS = new Set(["--no-color"]);

export interface TuiLaunchInput {
  argv: readonly string[];
  stdinIsTTY: boolean;
  stdoutIsTTY: boolean;
}

export function resolveTuiLaunchMode(input: TuiLaunchInput): TuiLaunchMode {
  const [first] = input.argv;
  if (first === "tui") {
    const rest = input.argv.slice(1);
    if (rest.some((arg) => DIRECT_FLAGS.has(arg))) {
      return { mode: "direct", reason: "reserved" };
    }
    return { mode: "tui", explicit: true };
  }
  if (input.argv.length > 0 && input.argv.every((arg) => TUI_ONLY_FLAGS.has(arg))) {
    if (input.stdinIsTTY && input.stdoutIsTTY) {
      return { mode: "tui", explicit: false };
    }
    return { mode: "help", reason: "non-interactive" };
  }
  if (input.argv.length > 0) {
    const reason = DIRECT_FLAGS.has(first ?? "") || DIRECT_COMMANDS.has(first ?? "") || input.argv.includes("--json")
      ? "reserved"
      : "subcommand";
    return { mode: "direct", reason };
  }
  if (input.stdinIsTTY && input.stdoutIsTTY) {
    return { mode: "tui", explicit: false };
  }
  return { mode: "help", reason: "non-interactive" };
}

export function isScriptableDirectInvocation(argv: readonly string[]): boolean {
  const [first] = argv;
  if (!first) {
    return false;
  }
  if (first === "tui") {
    return argv.slice(1).some((arg) => DIRECT_FLAGS.has(arg));
  }
  return DIRECT_FLAGS.has(first) || DIRECT_COMMANDS.has(first) || argv.includes("--json");
}

export function conciseNonInteractiveHelp(): string {
  return [
    "Matrix OS CLI",
    "Usage: matrix <command>",
    "Run `matrix --help` for commands or `matrix tui` in an interactive terminal.",
    "Direct commands remain script-safe.",
  ].join("\n");
}
