/** Bounded child-process helpers and failure classification for the owner-host Git/forge driver. */
import { spawn } from "node:child_process";

export type GitCommandResult = { stdout: string; stderr: string };

export function isGitExitCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && String((error as NodeJS.ErrnoException).code) === code;
}

export interface GitProcessFailure {
  /** A string code is a spawn failure (ENOENT, E2BIG, EACCES); a number is the exit status. */
  code?: string | number | null;
  signal?: string | null;
  killed?: boolean;
  stdout?: string;
  stderr?: string;
}

/** stderr lines Git prints before any ref transfer starts (discovery, auth, DNS, connect). */
const PRE_TRANSFER_PUSH_FAILURE = /could not read Username|Authentication failed|Permission denied|Permission to .* denied|Repository not found|Could not resolve host|Connection refused|Failed to connect|unable to access|requested URL returned error|does not appear to be a git repository|src refspec .* does not match any|terminal prompts disabled/i;

export function processFailure(error: unknown): GitProcessFailure {
  if (!(error instanceof Error)) return {};
  const failure = error as Error & GitProcessFailure;
  return { code: failure.code, signal: failure.signal, killed: failure.killed, stdout: failure.stdout, stderr: failure.stderr };
}

/**
 * Only a loss during the transfer phase leaves the remote outcome unknown.
 * Spawn failures, a rejected ref in `--porcelain` output and pre-transfer
 * errors certainly had no remote effect and must not block the scope.
 */
export function classifyPushFailure(failure: GitProcessFailure): "failed" | "unknown" {
  if (typeof failure.code === "string") return "failed";
  if (failure.killed || failure.signal) return "unknown";
  const refLines = (failure.stdout ?? "").split("\n").filter((line) => /^[ +\-*!=]\t/.test(line));
  if (refLines.length > 0) return refLines.some((line) => line.startsWith("!")) ? "failed" : "unknown";
  return PRE_TRANSFER_PUSH_FAILURE.test(failure.stderr ?? "") ? "failed" : "unknown";
}

const MAX_PROCESS_OUTPUT = 64 * 1024;

/**
 * Bounded spawn with stdin: execFile cannot feed stdin, and a PR body passed
 * as one argv entry exceeds the kernel's per-argument limit (E2BIG). Failures
 * carry the same shape as execFile errors (code, signal, killed, stdout, stderr).
 */
export function runProcess(command: string, args: string[], options: {
  cwd: string; env: NodeJS.ProcessEnv; timeout: number; stdin: string;
}): Promise<GitCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let overflow = false;
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, options.timeout);
    const settle = (error: (Error & GitProcessFailure) | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(Object.assign(error, { stdout, stderr }));
      else resolve({ stdout, stderr });
    };
    const collect = (stream: "stdout" | "stderr") => (chunk: Buffer) => {
      if (stream === "stdout") stdout += chunk.toString("utf8");
      else stderr += chunk.toString("utf8");
      if (stdout.length + stderr.length > MAX_PROCESS_OUTPUT && !overflow) {
        overflow = true;
        child.kill("SIGKILL");
      }
    };
    child.stdout.on("data", collect("stdout"));
    child.stderr.on("data", collect("stderr"));
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      // The child may exit before consuming stdin; the exit status decides the outcome.
      if (error.code !== "EPIPE") console.warn("[collaboration-git] process stdin failed", error.code ?? error.name);
    });
    child.on("error", (error: NodeJS.ErrnoException) => settle(Object.assign(error, { code: error.code ?? "ESPAWN" })));
    child.on("close", (code, signal) => {
      if (overflow) return settle(Object.assign(new Error(`${command} output exceeded limit`), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }));
      if (timedOut) return settle(Object.assign(new Error(`${command} timed out`), { code: null, signal: signal ?? "SIGKILL", killed: true }));
      if (code === 0) return settle(null);
      settle(Object.assign(new Error(`${command} exited with ${code ?? signal}`), { code, signal, killed: child.killed }));
    });
    child.stdin.end(options.stdin);
  });
}

/**
 * The project root must own its repository: `.git` is a real directory (not a
 * gitdir file or symlink that could point the owner-credentialed host Git at
 * another repository) and Git resolves both the toplevel and the gitdir to it.
 */
