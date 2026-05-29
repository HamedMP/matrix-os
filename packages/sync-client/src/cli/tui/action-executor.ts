import { spawn } from "node:child_process";
import { createTuiSafeError, normalizeTuiError, type TuiSafeError } from "./errors.js";
import type { TuiAction, TuiActionPrerequisite, TuiActionRefreshTarget } from "./actions.js";
import type { TuiStatusSnapshot } from "./status.js";

export type TuiActionExecutionStatus = "idle" | "running" | "succeeded" | "failed" | "cancelled";

export interface TuiActionExecutionContext {
  snapshot?: TuiStatusSnapshot;
  now?: () => Date;
}

export interface TuiActionExecutionResult {
  actionId: string;
  status: Exclude<TuiActionExecutionStatus, "idle" | "running">;
  message: string;
  refreshes: TuiActionRefreshTarget[];
  recoveryHint?: string;
  error?: TuiSafeError;
  completedAt: string;
}

export interface TuiActionExecutionState {
  actionId?: string;
  status: TuiActionExecutionStatus;
  message?: string;
  recoveryHint?: string;
  error?: TuiSafeError;
}

export interface TuiActionExecutor {
  execute(action: TuiAction, context?: TuiActionExecutionContext): Promise<TuiActionExecutionResult>;
  canExecute?(action: TuiAction, context?: TuiActionExecutionContext): TuiActionPrerequisite[];
}

export interface DirectCommandResult {
  exitCode: number;
  output: string;
}

export type DirectCommandRunner = (
  action: TuiAction,
  options: { signal: AbortSignal },
) => Promise<DirectCommandResult>;

export interface TuiActionExecutorOptions {
  runDirectCommand?: DirectCommandRunner;
  now?: () => Date;
  timeoutMs?: number;
}

export function missingPrerequisitesForAction(
  action: TuiAction,
  snapshot?: TuiStatusSnapshot,
): TuiActionPrerequisite[] {
  const prerequisites = action.prerequisites ?? [];
  if (!snapshot || prerequisites.length === 0) {
    return [];
  }
  return prerequisites.filter((prerequisite) => {
    if (prerequisite === "auth") {
      return snapshot.auth.state !== "authenticated";
    }
    if (prerequisite === "gateway") {
      return snapshot.gateway.state !== "healthy";
    }
    if (prerequisite === "local-profile") {
      return snapshot.profile.name === "unknown";
    }
    return false;
  });
}

export function createUnavailableActionResult(
  action: TuiAction,
  missing: readonly TuiActionPrerequisite[],
  now: () => Date = () => new Date(),
): TuiActionExecutionResult {
  const missingLabel = missing.join(", ");
  const error = createTuiSafeError("action_unavailable", {
    message: missing.length > 0 ? `Missing prerequisite: ${missingLabel}` : "Action unavailable",
  });
  return {
    actionId: action.id,
    status: "failed",
    message: error.message,
    refreshes: [],
    recoveryHint: missing.includes("auth") ? "Run login and try again." : "Run doctor and try again.",
    error,
    completedAt: now().toISOString(),
  };
}

function parseRegisteredDirectCommand(action: TuiAction): { command: string; args: string[] } | null {
  if (!action.directCommand) {
    return null;
  }
  const parts = action.directCommand.trim().split(/\s+/).filter(Boolean);
  if (parts[0] !== "matrix") {
    throw createTuiSafeError("invalid_request");
  }
  return { command: parts[0], args: parts.slice(1) };
}

export function runRegisteredDirectCommand(action: TuiAction, options: { signal: AbortSignal }): Promise<DirectCommandResult> {
  const parsed = parseRegisteredDirectCommand(action);
  if (!parsed) {
    return Promise.resolve({ exitCode: 0, output: `${action.title} is ready` });
  }
  return new Promise((resolve, reject) => {
    const child = spawn(parsed.command, parsed.args, {
      env: process.env,
      shell: false,
      signal: options.signal,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let errorOutput = "";
    const appendOutput = (chunk: Buffer, target: "stdout" | "stderr") => {
      const next = chunk.toString("utf8");
      if (target === "stdout") {
        output = `${output}${next}`.slice(-4096);
      } else {
        errorOutput = `${errorOutput}${next}`.slice(-4096);
      }
    };
    child.stdout?.on("data", (chunk: Buffer) => appendOutput(chunk, "stdout"));
    child.stderr?.on("data", (chunk: Buffer) => appendOutput(chunk, "stderr"));
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        exitCode: code ?? 1,
        output: (code === 0 ? output : errorOutput || output).trim(),
      });
    });
  });
}

export function createTuiActionExecutor(options: TuiActionExecutorOptions = {}): TuiActionExecutor {
  const runDirectCommand = options.runDirectCommand ?? runRegisteredDirectCommand;
  const defaultNow = options.now ?? (() => new Date());
  const timeoutMs = options.timeoutMs ?? 120_000;

  return {
    async execute(action, context = {}) {
      const now = context.now ?? defaultNow;
      const missing = missingPrerequisitesForAction(action, context.snapshot);
      if (missing.length > 0) {
        return createUnavailableActionResult(action, missing, now);
      }
      try {
        const signal = AbortSignal.timeout(timeoutMs);
        const commandResult = await runDirectCommand(action, { signal });
        if (commandResult.exitCode !== 0) {
          const safeError = createTuiSafeError("request_failed", { message: commandResult.output });
          return {
            actionId: action.id,
            status: "failed",
            message: safeError.message,
            refreshes: [],
            recoveryHint: "Run doctor and try again.",
            error: safeError,
            completedAt: now().toISOString(),
          };
        }
        return {
          actionId: action.id,
          status: "succeeded",
          message: commandResult.output || `${action.title} complete`,
          refreshes: action.refreshes ?? [],
          completedAt: now().toISOString(),
        };
      } catch (error) {
        const safeError = normalizeTuiError(error);
        return {
          actionId: action.id,
          status: "failed",
          message: safeError.message,
          refreshes: [],
          recoveryHint: "Run doctor and try again.",
          error: safeError,
          completedAt: now().toISOString(),
        };
      }
    },
    canExecute(action, context = {}) {
      return missingPrerequisitesForAction(action, context.snapshot);
    },
  };
}

export const createStaticTuiActionExecutor = createTuiActionExecutor;
