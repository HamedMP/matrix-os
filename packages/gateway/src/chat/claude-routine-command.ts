import { ROUTINE_CLI_INPUT_BYTES } from "@matrix-os/contracts/routine-cli";
/** Literal argv and one quoted heredoc only. Never evaluates shell, expands variables or selects an executable.
 * The published CLI remains the intent parser; this guard only excludes shell grammar and transport overrides. */
export function parseClaudeRoutineCommand(command: string): { args: string[]; stdin?: string } | null {
  if (!/^\s*(?:matrix|matrixos|mos)\s+routines(?:\s|$)/.test(command)) return null;
  if (Buffer.byteLength(command) > ROUTINE_CLI_INPUT_BYTES + 4096) throw new Error("Use a bounded literal routines command");
  let head = command.trim(), stdin: string | undefined;
  const heredoc = / <<'MATRIX_ROUTINE_JSON'\n([\s\S]*)\nMATRIX_ROUTINE_JSON$/.exec(head);
  if (heredoc) { stdin = heredoc[1]; head = head.slice(0, heredoc.index); }
  if (!/^[A-Za-z0-9_ .:=\-]+$/.test(head)) throw new Error("Use a single literal routines command");
  const tokens = head.split(/ +/), args = tokens.slice(2);
  if (args.length > 12 || args.some(arg => arg.length > 2048) || args.some(arg => arg.startsWith("-") && arg !== "-" && !/^(?:--json|--input|--request-id|--revision)$/.test(arg))) throw new Error("Unsupported routines command option");
  if (stdin !== undefined && (args[0] !== "propose" || !args.includes("--input") || Buffer.byteLength(stdin) > ROUTINE_CLI_INPUT_BYTES)) throw new Error("Invalid routines input");
  return { args, ...(stdin === undefined ? {} : { stdin }) };
}
