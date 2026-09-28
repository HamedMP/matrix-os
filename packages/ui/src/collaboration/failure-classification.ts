import { CollaborationFailureCodeSchema } from "@matrix-os/contracts";

export type CollaborationFailureState = "unavailable" | "host_offline" | "upgrade_required"
  | "relay_limit" | "access_removed" | "forbidden" | "unauthorized" | "resource_missing" | "paused";
export interface ClassifiedCollaborationFailure {
  state: CollaborationFailureState;
  reconnect: boolean;
  message: string;
  retryAfterSeconds?: number;
}

const STATES = {
  unavailable: { state: "unavailable", reconnect: true, message: "Collaboration is unavailable. Try again." },
  host_offline: { state: "host_offline", reconnect: true, message: "The owner's computer is offline. Trying again." },
  upgrade_required: { state: "upgrade_required", reconnect: false, message: "Update Matrix OS to continue." },
  relay_limit: { state: "relay_limit", reconnect: false, message: "Today's collaboration limit is reached. Try again after reset." },
  not_found: { state: "access_removed", reconnect: false, message: "This item is no longer shared with you." },
  forbidden: { state: "forbidden", reconnect: false, message: "Your role cannot perform this action." },
  unauthorized: { state: "unauthorized", reconnect: false, message: "Sign in again to continue." },
  resource_missing: { state: "resource_missing", reconnect: false, message: "This item was moved or deleted by its owner." },
  paused: { state: "paused", reconnect: false, message: "The owner updated this item; waiting for them to keep sharing it." },
} as const;

const EXPECTED_STATUS = {
  unavailable: 503, host_offline: 503, upgrade_required: 426, relay_limit: 429,
  not_found: 404, forbidden: 403, unauthorized: 401, resource_missing: 404, paused: 423,
} as const;

/** Classifies a bounded wire failure. Text from the server is never displayed. */
export function classifyCollaborationFailure(input: { status: number; code?: unknown; retryAfterSeconds?: unknown; error?: unknown }): ClassifiedCollaborationFailure {
  const parsed = CollaborationFailureCodeSchema.safeParse(input.code);
  if (!parsed.success || EXPECTED_STATUS[parsed.data] !== input.status) return { ...STATES.unavailable };
  const result: ClassifiedCollaborationFailure = { ...STATES[parsed.data] };
  if (parsed.data === "relay_limit" && Number.isInteger(input.retryAfterSeconds)
    && typeof input.retryAfterSeconds === "number" && input.retryAfterSeconds > 0 && input.retryAfterSeconds <= 86_400) {
    result.retryAfterSeconds = input.retryAfterSeconds;
  }
  return result;
}

/** Handles the direct API's safe cause and legacy callers without trusting error text. */
export function classifyCollaborationClientError(error: unknown): ClassifiedCollaborationFailure {
  const outer = error && typeof error === "object" ? error as { code?: unknown; cause?: unknown; status?: unknown; retryAfterSeconds?: unknown } : null;
  const nested = outer?.cause && typeof outer.cause === "object"
    ? outer.cause as { code?: unknown; status?: unknown; retryAfterSeconds?: unknown } : null;
  const value = nested ?? outer;
  if (!value) return { ...STATES.unavailable };
  if (typeof value.status === "number") return classifyCollaborationFailure(value as { status: number; code?: unknown; retryAfterSeconds?: unknown });
  if (value.code === "access_removed" || value.code === "not_found") return { ...STATES.not_found };
  if (value.code === "host_offline") return { ...STATES.host_offline };
  if (value.code === "upgrade_required") return { ...STATES.upgrade_required };
  if (value.code === "relay_limit") {
    const retry = typeof value.retryAfterSeconds === "number" && Number.isInteger(value.retryAfterSeconds)
      && value.retryAfterSeconds > 0 && value.retryAfterSeconds <= 86_400 ? value.retryAfterSeconds : undefined;
    return { ...STATES.relay_limit, ...(retry ? { retryAfterSeconds: retry } : {}) };
  }
  if (value.code === "forbidden") return { ...STATES.forbidden };
  if (value.code === "unauthorized" || value.code === "denied") return { ...STATES.unauthorized };
  if (value.code === "resource_missing") return { ...STATES.resource_missing };
  if (value.code === "paused") return { ...STATES.paused };
  return { ...STATES.unavailable };
}
