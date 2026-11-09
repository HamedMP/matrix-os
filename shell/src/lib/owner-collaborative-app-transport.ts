import {
  CollaborationAppActionResponseSchema,
  CollaborationRevisionSchema,
  CollaborativeAppQueryResponseSchema,
  CollaborativeAppParticipantSchema,
  CollaborativeAppShareSchema,
  MAX_APP_DATABASE_REQUEST_BYTES,
  type CollaborativeAppParticipant,
} from "@matrix-os/contracts";
import { CollaborationDirectError } from "@matrix-os/ui";
import { z } from "zod/v4";

const AppIdSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9_-]+$/);
const ActionSchema = z.object({ action: z.string().min(1).max(64) }).passthrough();
const LegacyCountResponseSchema = z.strictObject({ count: z.number().int().nonnegative() });
const MAX_PENDING_MUTATIONS = 32;

interface OwnerCollaborationDirectClient {
  request(
    scopeId: string,
    method: "POST",
    path: string,
    body: unknown,
    conditions?: undefined,
    signal?: AbortSignal,
  ): Promise<unknown>;
  subscribeEvents(scopeId: string, handlers: {
    onEvent(): void | Promise<void>;
    onUnavailable(): void;
  }): () => void;
}

interface OwnerCollaborationApi {
  get(path: string, options?: { signal?: AbortSignal }): Promise<unknown>;
  direct: OwnerCollaborationDirectClient;
}

export interface OwnerCollaborativeAppTransport {
  refreshShare(signal?: AbortSignal): Promise<CollaborativeAppParticipant | null>;
  participant(signal?: AbortSignal): Promise<CollaborativeAppParticipant | null>;
  query(action: unknown, signal?: AbortSignal): Promise<{ result: unknown; revision: string }>;
  mutate(action: unknown, expectedRevision: string, signal?: AbortSignal): Promise<{
    result: unknown;
    revision: string;
    replayed: boolean;
  }>;
  retryMutation(signal?: AbortSignal): Promise<{ result: unknown; revision: string; replayed: boolean }>;
  close(): void;
}

interface PendingMutation {
  scopeId: string;
  clientRequestId: string;
  expectedRevision: string;
  action: Record<string, unknown>;
}

export function createOwnerCollaborativeAppTransport(input: {
  appId: string;
  api: OwnerCollaborationApi;
  legacyRequest(action: unknown, signal?: AbortSignal): Promise<unknown>;
  onChanged(): void;
  createRequestId?: () => string;
}): OwnerCollaborativeAppTransport {
  const appId = AppIdSchema.parse(input.appId);
  const encodedAppId = encodeURIComponent(appId);
  const requestId = input.createRequestId ?? (() => crypto.randomUUID());
  let subscribedScopeId: string | null = null;
  let unsubscribe: (() => void) | null = null;
  let subscriptionGeneration = 0;
  let closed = false;
  let uncertain: PendingMutation[] = [];
  const inFlight = new Set<string>();

  const stopSubscription = () => {
    const release = unsubscribe;
    unsubscribe = null;
    subscribedScopeId = null;
    subscriptionGeneration += 1;
    release?.();
  };

  const ensureSubscription = (scopeId: string) => {
    if (subscribedScopeId === scopeId) return;
    stopSubscription();
    const generation = subscriptionGeneration;
    const release = input.api.direct.subscribeEvents(scopeId, {
      onEvent: () => {
        if (!closed && subscriptionGeneration === generation) return input.onChanged();
      },
      onUnavailable: () => {
        if (closed || subscriptionGeneration !== generation) return;
        stopSubscription();
        input.onChanged();
      },
    });
    if (closed || subscriptionGeneration !== generation) {
      release();
      return;
    }
    unsubscribe = release;
    subscribedScopeId = scopeId;
  };

  const actionForApp = (raw: unknown): Record<string, unknown> => {
    const parsed = ActionSchema.safeParse(raw);
    if (!parsed.success || parsed.data.action === "listApps") throw unavailable();
    const action = { ...parsed.data, app: appId };
    let serialized: string;
    try {
      serialized = JSON.stringify(action);
    } catch (error: unknown) {
      console.warn("[owner-collaboration] action serialization failed", error instanceof Error ? error.name : "UnknownError");
      throw unavailable();
    }
    if (new TextEncoder().encode(serialized).length > MAX_APP_DATABASE_REQUEST_BYTES) throw unavailable();
    return action;
  };

  const currentShare = async (signal?: AbortSignal) => {
    if (closed) throw unavailable();
    const raw = await input.api.get(`/api/collaboration/apps/${encodedAppId}/share`, signal ? { signal } : undefined);
    if (closed || signal?.aborted) throw unavailable();
    if (raw === null) {
      stopSubscription();
      return null;
    }
    const parsed = CollaborativeAppShareSchema.safeParse(raw);
    if (!parsed.success || parsed.data.build.appId !== appId) throw unavailable();
    if (parsed.data.state === "stopped") {
      stopSubscription();
      return null;
    }
    if (parsed.data.state !== "active") {
      stopSubscription();
      throw unavailable();
    }
    ensureSubscription(parsed.data.scopeId);
    return parsed.data;
  };

  const sendMutation = async (attempt: PendingMutation, signal?: AbortSignal) => {
    if (closed || signal?.aborted) throw unavailable();
    inFlight.add(attempt.clientRequestId);
    try {
      const response = CollaborationAppActionResponseSchema.parse(await input.api.direct.request(
        attempt.scopeId,
        "POST",
        `/api/collaboration/scopes/${attempt.scopeId}/apps/${encodedAppId}/actions`,
        {
          clientRequestId: attempt.clientRequestId,
          expectedRevision: attempt.expectedRevision,
          action: attempt.action,
        },
        undefined,
        signal,
      ));
      uncertain = uncertain.filter((candidate) => candidate.clientRequestId !== attempt.clientRequestId);
      return { ...response, revision: String(response.revision) };
    } catch (error: unknown) {
      console.warn("[owner-collaboration] mutation unavailable", error instanceof Error ? error.name : "UnknownError");
      if (isUncertain(error)
        && !uncertain.some((candidate) => candidate.clientRequestId === attempt.clientRequestId)) {
        uncertain.push(attempt);
      } else if (!isUncertain(error)) {
        uncertain = uncertain.filter((candidate) => candidate.clientRequestId !== attempt.clientRequestId);
      }
      throw unavailable();
    } finally {
      inFlight.delete(attempt.clientRequestId);
    }
  };

  return {
    async refreshShare(signal) {
      const share = await currentShare(signal);
      return share ? participantForShare(share) : null;
    },
    async participant(signal) {
      const share = await currentShare(signal);
      return share ? participantForShare(share) : null;
    },
    async query(rawAction, signal) {
      const action = actionForApp(rawAction);
      const share = await currentShare(signal);
      if (closed || signal?.aborted) throw unavailable();
      if (!share) {
        const result = await input.legacyRequest(action, signal);
        if (action.action === "count") {
          const count = LegacyCountResponseSchema.safeParse(result);
          if (!count.success) throw unavailable();
          return { result: count.data.count, revision: "0" };
        }
        return { result, revision: "0" };
      }
      return CollaborativeAppQueryResponseSchema.parse(await input.api.direct.request(
        share.scopeId,
        "POST",
        `/api/collaboration/scopes/${share.scopeId}/apps/${encodedAppId}/view`,
        { action },
        undefined,
        signal,
      ));
    },

    async mutate(rawAction, rawExpectedRevision, signal) {
      const action = actionForApp(rawAction);
      const expectedRevision = CollaborationRevisionSchema.safeParse(rawExpectedRevision);
      if (!expectedRevision.success) throw unavailable();
      const share = await currentShare(signal);
      if (closed || signal?.aborted) throw unavailable();
      if (!share) {
        return {
          result: await input.legacyRequest(action, signal),
          revision: "0",
          replayed: false,
        };
      }
      if (uncertain.length + inFlight.size >= MAX_PENDING_MUTATIONS) throw unavailable();
      return sendMutation({
        scopeId: share.scopeId,
        clientRequestId: requestId(),
        expectedRevision: expectedRevision.data,
        action,
      }, signal);
    },

    async retryMutation(signal) {
      const [first, ...remaining] = uncertain;
      if (!first) throw unavailable();
      let result = await sendMutation(first, signal);
      for (const attempt of remaining) result = await sendMutation(attempt, signal);
      return result;
    },

    close() {
      closed = true;
      stopSubscription();
    },
  };
}

function participantForShare(share: z.infer<typeof CollaborativeAppShareSchema>): CollaborativeAppParticipant {
  return CollaborativeAppParticipantSchema.parse({
    actorId: share.owner.actorId,
    displayName: share.owner.displayName,
    organizationId: share.organizationId,
    scopeId: share.scopeId,
    shareRevision: share.shareRevision,
    buildId: share.build.buildId,
  });
}

function unavailable(): Error {
  return new Error("Collaboration unavailable");
}

function isUncertain(error: unknown): boolean {
  return !(error instanceof CollaborationDirectError)
    || error.code === "host_offline"
    || error.code === "unavailable"
    || error.code === "invalid_response";
}
