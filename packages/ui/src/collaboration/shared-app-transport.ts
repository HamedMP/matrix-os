import {
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
  | "invalid_response";

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
  subscribe(handlers: { onChanged(): void | Promise<void>; onUnavailable(): void }): () => void;
  close(): void;
}

interface PendingMutation {
  clientRequestId: string;
  expectedRevision: string;
  action: unknown;
}

export function createSharedAppTransport(input: {
  platform: SharedAppPlatformApi;
  direct: Pick<CollaborationDirectClient, "request" | "subscribeEvents" | "close">;
  target: SharedAppTarget;
}): SharedAppTransport {
  const target = CollaborativeAppDirectoryItemSchema.parse(input.target);
  const base = `/api/collaboration/scopes/${target.scopeId}/apps/${encodeURIComponent(target.appId)}`;
  let launchRequestId: string | null = null;
  let uncertain: PendingMutation[] = [];
  let pendingFailure: SharedAppTransportError | null = null;
  let retryInFlight: ReturnType<SharedAppTransport["retryMutation"]> | null = null;
  let closed = false;
  const inFlight = new Set<string>();

  const requireOpen = () => {
    if (closed) throw new SharedAppTransportError("unavailable", false);
  };

  const launch = async () => {
    requireOpen();
    launchRequestId ??= crypto.randomUUID();
    try {
      const response = CollaborativeAppLaunchResponseSchema.parse(await input.platform.post(
        `/api/collaboration/shared-apps/${target.scopeId}/launch`,
        {
          clientRequestId: launchRequestId,
          expectedShareRevision: target.shareRevision,
          expectedBuildId: target.buildId,
        },
      ));
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
    requireOpen();
    try {
      return CollaborativeAppQueryResponseSchema.parse(await input.direct.request(
        target.scopeId, "POST", `${base}/view`, { action },
      ));
    } catch (error: unknown) {
      throw normalize(error, "unavailable");
    }
  };

  const sendMutation = async (attempt: PendingMutation) => {
    requireOpen();
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
      if (normalized.code === "host_offline" || normalized.code === "unavailable"
        || normalized.code === "invalid_response") {
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

  const recoverMutations = async () => {
    const attempts = [...uncertain];
    if (attempts.length === 0) {
      pendingFailure = null;
      throw new SharedAppTransportError("conflict", false);
    }
    let result: { result: unknown; revision: string; replayed: boolean } | undefined;
    for (const attempt of attempts) {
      try {
        result = await sendMutation(attempt);
      } catch (error: unknown) {
        const failure = normalize(error, "unavailable");
        if (failure.code !== "uncertain"
          && (!pendingFailure || pendingFailure.code === "conflict")) {
          pendingFailure = failure;
        }
      }
    }
    if (uncertain.length > 0) throw new SharedAppTransportError("uncertain", true);
    if (pendingFailure) {
      const failure = pendingFailure;
      pendingFailure = null;
      throw failure;
    }
    // Nonempty recovery either produced a result or reported its failure above.
    return result!;
  };

  return {
    target,
    launch,
    query,
    async mutate(action, expectedRevision) {
      requireOpen();
      if (uncertain.length + inFlight.size >= MAX_PENDING_MUTATIONS) {
        throw new SharedAppTransportError("unavailable", true);
      }
      const attempt = { clientRequestId: crypto.randomUUID(), expectedRevision, action };
      return sendMutation(attempt);
    },
    async retryMutation() {
      requireOpen();
      if (retryInFlight) return retryInFlight;
      const recovery = recoverMutations().finally(() => {
        retryInFlight = null;
      });
      retryInFlight = recovery;
      return recovery;
    },
    subscribe(handlers) {
      requireOpen();
      return input.direct.subscribeEvents(target.scopeId, {
        onEvent: handlers.onChanged,
        onUnavailable: handlers.onUnavailable,
      });
    },
    close() {
      if (closed) return;
      closed = true;
      input.direct.close(target.scopeId);
    },
  };
}

function normalize(error: unknown, fallback: SharedAppFailureCode): SharedAppTransportError {
  if (error instanceof SharedAppTransportError) return error;
  if (error instanceof CollaborationDirectError) {
    if (error.code === "host_offline") return new SharedAppTransportError("host_offline", true);
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
  return "Shared app is unavailable.";
}
