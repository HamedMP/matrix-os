import { randomUUID } from "../random-uuid.js";
import {
  CollaborativeAppDataReadResponseSchema,
  CollaborativeAppDirectoryItemSchema,
  CollaborativeAppLaunchResponseSchema,
  CollaborativeAppQueryResponseSchema,
  CollaborationAppActionResponseSchema,
  type CollaborativeAppDirectoryItem,
  type CollaborativeAppLaunchResponse,
} from "@matrix-os/contracts";

import {
  CollaborationDirectError,
  type CollaborationDirectClient,
} from "./direct-client.js";

const MAX_PENDING_MUTATIONS = 32;

export type SharedAppTarget = CollaborativeAppDirectoryItem;
export type SharedAppFailureCode =
  | "conflict"
  | "uncertain"
  | "host_offline"
  | "access_ended"
  | "needs_recheck"
  | "unavailable"
  | "invalid_response"
  /** The share is view-only; the app stays open and its write is refused. */
  | "read_only";

export class SharedAppTransportError extends Error {
  constructor(public readonly code: SharedAppFailureCode, public readonly retryable: boolean) {
    super(messageFor(code));
    this.name = "SharedAppTransportError";
  }
}

export interface SharedAppPlatformApi {
  get(path: string): Promise<unknown>;
  post(path: string, body: unknown): Promise<unknown>;
}

export interface SharedAppTransport {
  readonly target: SharedAppTarget;
  launch(): Promise<CollaborativeAppLaunchResponse>;
  query(action: unknown): Promise<{ result: unknown; revision: string }>;
  mutate(action: unknown, expectedRevision: string): Promise<{ result: unknown; revision: string; replayed: boolean }>;
  retryMutation(): Promise<{ result: unknown; revision: string; replayed: boolean }>;
  /** One owner key-value entry for the app's `readData`; `null` when unset. */
  readData(key: string): Promise<string | null>;
  subscribe(handlers: { onChanged(): void | Promise<void>; onUnavailable(): void }): () => void;
  close(): void;
}

interface PendingMutation {
  clientRequestId: string;
  expectedRevision: string;
  action: unknown;
}

/** A launch request already sent for this target; settled so it never rejects unobserved. */
export interface SharedAppInitialLaunch {
  clientRequestId: string;
  result: Promise<{ ok: true; value: unknown } | { ok: false; error: unknown }>;
}

/** Sends the idempotent launch request for a target whose build and share revision are already known. */
export function startSharedAppLaunch(
  platform: Pick<SharedAppPlatformApi, "post">,
  scopeId: string,
  expected: { buildId: string; shareRevision: string },
): SharedAppInitialLaunch {
  const clientRequestId = randomUUID();
  const result = Promise.resolve()
    .then(() => platform.post(`/api/collaboration/shared-apps/${encodeURIComponent(scopeId)}/launch`, {
      clientRequestId,
      expectedShareRevision: expected.shareRevision,
      expectedBuildId: expected.buildId,
    }))
    .then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }));
  return { clientRequestId, result };
}

export function createSharedAppTransport(input: {
  platform: SharedAppPlatformApi;
  direct: Pick<CollaborationDirectClient, "request" | "subscribeEvents" | "close">;
  target: SharedAppTarget;
  /** Consumed by the first `launch()`; later launches retry with the same client request id. */
  initialLaunch?: SharedAppInitialLaunch;
}): SharedAppTransport {
  const target = CollaborativeAppDirectoryItemSchema.parse(input.target);
  const base = `/api/collaboration/scopes/${target.scopeId}/apps/${encodeURIComponent(target.appId)}`;
  let initialLaunch = input.initialLaunch ?? null;
  let launchRequestId: string | null = initialLaunch?.clientRequestId ?? null;
  let uncertain: PendingMutation[] = [];
  let pendingConflict = false;
  const inFlight = new Set<string>();

  const requestLaunch = async (): Promise<unknown> => {
    const started = initialLaunch;
    initialLaunch = null;
    if (started) {
      const settled = await started.result;
      if (!settled.ok) throw settled.error;
      return settled.value;
    }
    launchRequestId ??= randomUUID();
    return input.platform.post(
      `/api/collaboration/shared-apps/${target.scopeId}/launch`,
      {
        clientRequestId: launchRequestId,
        expectedShareRevision: target.shareRevision,
        expectedBuildId: target.buildId,
      },
    );
  };

  const launch = async () => {
    try {
      const response = CollaborativeAppLaunchResponseSchema.parse(await requestLaunch());
      if (response.target.scopeId !== target.scopeId || response.target.appId !== target.appId
        || response.target.buildId !== target.buildId || response.target.shareRevision !== target.shareRevision) {
        throw new SharedAppTransportError("invalid_response", false);
      }
      return response;
    } catch (error: unknown) {
      throw normalize(error, "unavailable");
    }
  };

  const query = async (action: unknown): Promise<{ result: unknown; revision: string }> => {
    try {
      return CollaborativeAppQueryResponseSchema.parse(await input.direct.request(
        target.scopeId, "POST", `${base}/view`, { action },
      ));
    } catch (error: unknown) {
      throw normalize(error, "unavailable");
    }
  };

  const sendMutation = async (attempt: PendingMutation) => {
    inFlight.add(attempt.clientRequestId);
    try {
      const response = CollaborationAppActionResponseSchema.parse(await input.direct.request(
        target.scopeId,
        "POST",
        `${base}/actions`,
        attempt,
      ));
      uncertain = uncertain.filter((candidate) => candidate.clientRequestId !== attempt.clientRequestId);
      return { ...response, revision: String(response.revision) };
    } catch (error: unknown) {
      const normalized = normalize(error, "unavailable");
      if (normalized.code === "host_offline" || normalized.code === "unavailable") {
        if (!uncertain.some((candidate) => candidate.clientRequestId === attempt.clientRequestId)) {
          uncertain.push(attempt);
        }
        throw new SharedAppTransportError("uncertain", true);
      }
      uncertain = uncertain.filter((candidate) => candidate.clientRequestId !== attempt.clientRequestId);
      throw normalized;
    } finally {
      inFlight.delete(attempt.clientRequestId);
    }
  };

  const readData = async (key: string): Promise<string | null> => {
    // The owner's gateway normalizes the key exactly like the owner's own bridge.
    if (key.length < 1 || key.length > 256) throw new SharedAppTransportError("unavailable", false);
    try {
      return CollaborativeAppDataReadResponseSchema.parse(await input.direct.request(
        target.scopeId, "GET", `${base}/data?key=${encodeURIComponent(key)}`,
      )).value;
    } catch (error: unknown) {
      throw normalize(error, "unavailable");
    }
  };

  return {
    target,
    launch,
    query,
    readData,
    mutate(action, expectedRevision) {
      if (uncertain.length + inFlight.size >= MAX_PENDING_MUTATIONS) {
        return Promise.reject(new SharedAppTransportError("unavailable", true));
      }
      const attempt = { clientRequestId: randomUUID(), expectedRevision, action };
      return sendMutation(attempt);
    },
    async retryMutation() {
      const attempts = [...uncertain];
      if (attempts.length === 0) {
        pendingConflict = false;
        throw new SharedAppTransportError("conflict", false);
      }
      let result: { result: unknown; revision: string; replayed: boolean } | undefined;
      let firstFailure: unknown;
      for (const attempt of attempts) {
        try {
          result = await sendMutation(attempt);
        } catch (error: unknown) {
          if (error instanceof SharedAppTransportError && error.code === "conflict") {
            pendingConflict = true;
          } else {
            firstFailure ??= error;
          }
        }
      }
      if (uncertain.length > 0) throw new SharedAppTransportError("uncertain", true);
      if (firstFailure) throw firstFailure;
      if (pendingConflict) {
        pendingConflict = false;
        throw new SharedAppTransportError("conflict", false);
      }
      if (!result) throw new SharedAppTransportError("conflict", false);
      return result;
    },
    subscribe(handlers) {
      return input.direct.subscribeEvents(target.scopeId, {
        onEvent: handlers.onChanged,
        onUnavailable: handlers.onUnavailable,
      });
    },
    close() { input.direct.close(target.scopeId); },
  };
}

function normalize(error: unknown, fallback: SharedAppFailureCode): SharedAppTransportError {
  if (error instanceof SharedAppTransportError) return error;
  if (error instanceof CollaborationDirectError) {
    if (error.code === "host_offline") return new SharedAppTransportError("host_offline", true);
    if (error.code === "read_only") return new SharedAppTransportError("read_only", false);
    if (error.code === "denied" || error.code === "not_found" || error.code === "unauthenticated") {
      return new SharedAppTransportError("access_ended", false);
    }
    if (error.code === "invalid_request") return new SharedAppTransportError("conflict", false);
    if (error.code === "invalid_response") return new SharedAppTransportError("invalid_response", false);
  }
  console.warn("[shared-app] request unavailable", error instanceof Error ? error.name : "UnknownError");
  return new SharedAppTransportError(fallback, fallback === "host_offline" || fallback === "unavailable");
}

function messageFor(code: SharedAppFailureCode): string {
  if (code === "conflict") return "This shared app changed. Review your edit before trying again.";
  if (code === "uncertain") return "The change may have reached the shared app. Retry safely to confirm it.";
  if (code === "host_offline") return "The owner’s computer is offline.";
  if (code === "access_ended") return "Access to this shared app has ended.";
  if (code === "needs_recheck") return "This shared app needs to be checked again by its owner.";
  if (code === "read_only") return "This app is view-only. Ask the owner to make it collaborative.";
  return "Shared app is unavailable.";
}
