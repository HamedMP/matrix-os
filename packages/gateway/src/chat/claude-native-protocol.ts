import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { delimiter, isAbsolute, resolve } from "node:path";
import { spawnIsolatedProviderProcess } from "../coding-agents/provider-process-isolation.js";
import { CanonicalCliError, runCanonicalCli, type CanonicalCliProcess, type CanonicalCliSpawn } from "./cli-process.js";

export class ClaudeNativeProbeCleanupError extends Error {
  readonly name = "ClaudeNativeProbeCleanupError";
}
/** Resolve through precisely the Chat launch PATH, then pin probe and inference to it. */
async function executable(command: string, cwd: string, env: Record<string, string>) {
  if (isAbsolute(command)) return command;
  if (!command.includes("/") && env.PATH === undefined) return command;
  const candidates = command.includes("/") ? [resolve(cwd, command)]
    : (env.PATH ?? "").split(delimiter).map(directory => resolve(cwd, directory, command));
  for (const candidate of candidates) {
    try { await access(candidate, constants.X_OK); if ((await stat(candidate)).isFile()) return candidate; }
    catch (error: unknown) {
      if (!(error instanceof Error) || !("code" in error) || !["ENOENT", "ENOTDIR", "EACCES"].includes(String(error.code))) throw error;
    }
  }
  return command;
}

/** A local, bounded version query; no user prompt, model request or account discovery. */
export async function resolveClaudeNativeProtocol(options: {
  command: string; cwd: string; env: Record<string, string>; signal: AbortSignal;
  spawnFn?: CanonicalCliSpawn; timeoutMs?: number;
}): Promise<{ command: string; qualified: boolean }> {
  options.signal.throwIfAborted();
  const command = await executable(options.command, options.cwd, options.env);
  options.signal.throwIfAborted();
  let output = "", stderr = false, failed = false, close: Promise<void> | undefined;
  try {
    await runCanonicalCli({ ...options, command, args: ["--version"], replaceEnv: true,
      timeoutMs: Math.min(5000, options.timeoutMs ?? 5000), maxStdoutBytes: 4096, maxStderrBytes: 4096,
      spawnFn: (cmd, args, scope) => {
        const child = (options.spawnFn ?? spawnIsolatedProviderProcess)(cmd, args, scope);
        close = new Promise<void>(done => {
          (child as CanonicalCliProcess & { once(event: "close", fn: () => void): void }).once("close", done);
        });
        return child;
      },
      onStdout: chunk => { output += chunk.toString(); }, onStderr: () => { stderr = true; },
    });
  } catch (error: unknown) {
    if (!(error instanceof CanonicalCliError)) throw error;
    if (error.kind !== "aborted") console.warn("[chat-claude] Native schedule version probe failed", error.kind);
    failed = true;
  }
  // Forced runner settlement alone never authorizes a fallback child.
  if (close) await new Promise<void>((done, reject) => {
    const timer = setTimeout(() => reject(new ClaudeNativeProbeCleanupError("Version child cleanup unconfirmed")), 1500); timer.unref?.();
    void close!.then(() => { clearTimeout(timer); done(); });
  });
  if (options.signal.aborted) throw new CanonicalCliError("aborted");
  return { command, qualified: isAbsolute(command) && !failed && !stderr && output.trim() === "2.1.317 (Claude Code)" };
}

/** Merge with all existing CLI denials; duplicate flags must never replace them. */
export function disallowNativeCronCreate(args: string[]): string[] {
  const retained: string[] = [], denied: string[] = []; let insertion: number | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--disallowedTools" || arg.startsWith("--disallowedTools=")) {
      insertion ??= retained.length;
      if (arg.includes("=")) denied.push(arg.slice(arg.indexOf("=") + 1));
      else while (index + 1 < args.length && !args[index + 1]!.startsWith("--")) denied.push(args[++index]!);
    } else retained.push(arg);
  }
  retained.splice(insertion ?? retained.length, 0, "--disallowedTools", ...new Set([...denied, "CronCreate"]));
  return retained;
}
