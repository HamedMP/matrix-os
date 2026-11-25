import { spawn } from "node:child_process";

// Runs host commands as argv arrays (never through a shell). Output is capped,
// and every call takes an AbortSignal so no command can hang hostd.

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  signal: AbortSignal;
}

export type Exec = (argv: readonly [string, ...string[]], options: ExecOptions) => Promise<ExecResult>;

export type ExecErrorCode = "spawn_failed" | "timeout" | "failed";

// The message names only the program; stderr stays on `stderr` for server-side
// logs and never reaches a client.
export class ExecError extends Error {
  readonly code: ExecErrorCode;
  readonly program: string;
  readonly exitCode: number | null;
  readonly stderr: string;

  constructor(
    code: ExecErrorCode,
    program: string,
    details: { exitCode?: number | null; stderr?: string; cause?: unknown } = {},
  ) {
    super(`${program} ${code === "failed" ? `exited with ${details.exitCode ?? "a signal"}` : code}`, {
      cause: details.cause,
    });
    this.name = "ExecError";
    this.code = code;
    this.program = program;
    this.exitCode = details.exitCode ?? null;
    this.stderr = details.stderr ?? "";
  }
}

const MAX_OUTPUT_BYTES = 256 * 1024;

function collector() {
  const chunks: Buffer[] = [];
  let size = 0;
  return {
    push(chunk: Buffer) {
      if (size >= MAX_OUTPUT_BYTES) return;
      const room = MAX_OUTPUT_BYTES - size;
      const kept = chunk.length > room ? chunk.subarray(0, room) : chunk;
      chunks.push(kept);
      size += kept.length;
    },
    text: () => Buffer.concat(chunks).toString("utf8"),
  };
}

export function createExec(): Exec {
  return (argv, { signal }) =>
    new Promise<ExecResult>((resolve, reject) => {
      const [program, ...args] = argv;
      if (signal.aborted) {
        reject(new ExecError("timeout", program));
        return;
      }
      const child = spawn(program, args, { shell: false, signal, stdio: ["ignore", "pipe", "pipe"] });
      const stdout = collector();
      const stderr = collector();
      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.on("error", (error: Error) => {
        if (signal.aborted) reject(new ExecError("timeout", program, { cause: error, stderr: stderr.text() }));
        else reject(new ExecError("spawn_failed", program, { cause: error }));
      });
      child.on("close", (code: number | null) => {
        if (signal.aborted) return;
        resolve({ code: code ?? -1, stdout: stdout.text(), stderr: stderr.text() });
      });
    });
}

// Runs a command and throws ExecError on a non-zero exit.
export async function run(exec: Exec, argv: readonly [string, ...string[]], signal: AbortSignal): Promise<ExecResult> {
  const result = await exec(argv, { signal });
  if (result.code !== 0) throw new ExecError("failed", argv[0], { exitCode: result.code, stderr: result.stderr });
  return result;
}
