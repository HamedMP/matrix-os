export interface TerminalCapabilityInput {
  stdin?: NodeJS.ReadStream & { isTTY?: boolean };
  stdout?: NodeJS.WriteStream & { isTTY?: boolean; columns?: number; rows?: number };
  env?: NodeJS.ProcessEnv;
  noColor?: boolean;
}

export interface TerminalCapabilities {
  isInteractive: boolean;
  columns: number;
  rows: number;
  isNarrow: boolean;
  isShort: boolean;
  noColor: boolean;
  supportsColor: boolean;
  minUsable: boolean;
}

export function getTerminalCapabilities(
  input: TerminalCapabilityInput = {},
): TerminalCapabilities {
  const stdin = input.stdin ?? process.stdin;
  const stdout = input.stdout ?? process.stdout;
  const env = input.env ?? process.env;
  const columns = Number.isInteger(stdout.columns) && stdout.columns && stdout.columns > 0
    ? stdout.columns
    : 80;
  const rows = Number.isInteger(stdout.rows) && stdout.rows && stdout.rows > 0
    ? stdout.rows
    : 24;
  const noColor = input.noColor === true || env.NO_COLOR !== undefined || env.TERM === "dumb";

  return {
    isInteractive: stdin.isTTY === true && stdout.isTTY === true,
    columns,
    rows,
    isNarrow: columns < 80,
    isShort: rows < 24,
    noColor,
    supportsColor: !noColor,
    minUsable: columns >= 40 && rows >= 12,
  };
}
