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

export function createStaticTuiActionExecutor(): TuiActionExecutor {
  return {
    async execute(action, context = {}) {
      const now = context.now ?? (() => new Date());
      const missing = missingPrerequisitesForAction(action, context.snapshot);
      if (missing.length > 0) {
        return createUnavailableActionResult(action, missing, now);
      }
      try {
        return {
          actionId: action.id,
          status: "succeeded",
          message: action.directCommand ? `Ready to run ${action.directCommand}` : `${action.title} is ready`,
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
