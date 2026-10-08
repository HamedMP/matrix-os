/**
 * BrainIntegrationCaller over the gateway's integration layer. Two transports, chosen once at construction:
 * - remote: a customer gateway reaches its owner's platform integrations through
 *   POST {internalBaseUrl}/read-call with the machine bearer and signed owner delegation (the same path the Jev
 *   read client uses). That route needs an account label, so a call without one first reads the owner's
 *   connections (GET {internalBaseUrl}) and takes the service's only one (several: invalid), cached briefly.
 * - local: a gateway that holds the platform database and Pipedream client (and no remote transport) runs
 *   executeIntegrationAction itself, for the platform user whose Clerk id (or platform id) is the owner id, as a
 *   byte-capped raw read (pipedream.boundedProxy) that the call's signal cancels. A call without a label takes the
 *   service's only account here too (several: invalid).
 * Only registry actions with risk "read" on Pipedream services are callable; a missing one is unavailable (a server
 * gap), not invalid. Provider text never leaves this file.
 */
import { z } from "zod/v4";
import { boundedOperation } from "../../../bounded-operation.js";
import { executeIntegrationAction } from "../../../integrations/action-execution.js";
import { getErrorStatusCode, getRetryAfterSeconds, isTimeoutError } from "../../../integrations/call-outcome.js";
import { resolveIntegrationConnection } from "../../../integrations/connection-selection.js";
import { delegatedIntegrationHeaders } from "../../../integrations/delegated-identity.js";
import { validateActionParams } from "../../../integrations/parameter-validation.js";
import { integrationClerkIdForPrincipal, type IntegrationIdentityEnv } from "../../../integrations/principal-identity.js";
import type { PipedreamConnectClient } from "../../../integrations/pipedream.js";
import { getAction, getService } from "../../../integrations/registry.js";
import { INTEGRATION_READ_SCOPE_HEADER } from "../../../integrations/scope-provenance.js";
import type { ServiceAction, ServiceDefinition } from "../../../integrations/types.js";
import type { PlatformDb } from "../../../platform-db.js";
import {
  BRAIN_INTEGRATION_RESPONSE_MAX_BYTES, BRAIN_INTEGRATION_RETRY_AFTER_MAX_SECONDS, BRAIN_INTEGRATION_SERVICES,
  type BrainIntegrationCallOutcome, type BrainIntegrationCallRequest, type BrainIntegrationCaller,
} from "../../contracts.js";
import { discardBody, readBoundedJson, readJsonField } from "./bounded-body.js";

export const BRAIN_INTEGRATION_CALL_TIMEOUT_MS = 15_000;
export const BRAIN_INTEGRATION_LABEL_CACHE_MAX = 256;
export const BRAIN_INTEGRATION_LABEL_CACHE_TTL_MS = 5 * 60_000;
/** Bytes of the platform's connection list (remote transport). */
export const BRAIN_INTEGRATION_CONNECTIONS_MAX_BYTES = 256 * 1024;
const CONNECTIONS_MAX_BYTES = BRAIN_INTEGRATION_CONNECTIONS_MAX_BYTES;
/** The delegation id rule: an owner id outside it never reaches the platform. */
export const BRAIN_INTEGRATION_OWNER_ID_PATTERN = /^[A-Za-z0-9_-]{1,256}$/;
const OWNER_ID_PATTERN = BRAIN_INTEGRATION_OWNER_ID_PATTERN;
/** Account labels: 1..100 characters, no control characters, no space at either end. */
export const BRAIN_INTEGRATION_LABEL_PATTERN = /^[^\s\p{Cc}](?:[^\p{Cc}]{0,98}[^\s\p{Cc}])?$/u;
const LABEL_PATTERN = BRAIN_INTEGRATION_LABEL_PATTERN;
const PLATFORM_USER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface BrainIntegrationRegistry {
  getService(serviceId: string): ServiceDefinition | undefined;
  getAction(serviceId: string, actionId: string): ServiceAction | undefined;
}

/**
 * internalBaseUrl: `${PLATFORM_INTERNAL_URL}/internal/containers/${MATRIX_HANDLE}/integrations` (remote transport,
 * needs machineToken; preferred when set, like the Jev read client). db + pipedream: the in-process platform
 * integrations (local transport). Neither: every call answers unavailable.
 */
export interface BrainIntegrationCallerDeps {
  readonly internalBaseUrl?: string | null;
  readonly machineToken?: string;
  readonly db?: Pick<PlatformDb, "listConnectedServices" | "getUserByClerkId" | "getUserById"> | null;
  readonly pipedream?: PipedreamConnectClient | null;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
  readonly registry?: BrainIntegrationRegistry;
  readonly now?: () => number;
  /**
   * The gateway's environment, for the local transport's identity rule (integrationClerkIdForPrincipal): outside
   * production the dev principal reads the connections the Settings connect flow stored. Absent: no mapping.
   */
  readonly env?: IntegrationIdentityEnv;
}

/** The platform's connection list (GET {internalBaseUrl}): only the fields read here. */
export const BrainIntegrationConnectionsSchema = z.array(z.object({
  service: z.string().max(100), account_label: z.string().max(200),
})).max(500);
const ConnectionsSchema = BrainIntegrationConnectionsSchema;
const EnvelopeSchema = z.object({ data: z.unknown(), action: z.string().max(100) });

type Outcome = BrainIntegrationCallOutcome;
const UNAVAILABLE: Outcome = { status: "unavailable" };

function retryAfter(seconds: number): Outcome {
  const bounded = Math.min(Math.max(Math.ceil(seconds), 1), BRAIN_INTEGRATION_RETRY_AFTER_MAX_SECONDS);
  return { status: "rate_limited", retryAfterSeconds: bounded };
}

function logFailure(transport: string, request: BrainIntegrationCallRequest, error: unknown): void {
  console.warn(`[brain-integration] ${transport} ${request.service}/${request.action} failed:`,
    error instanceof Error ? error.name : "UnknownError");
}

/** x-ratelimit-remaining of a provider error that has a status (Pipedream rawResponse headers, or plain headers). */
function rateLimitRemaining(error: unknown): unknown {
  const { headers, rawResponse } = error as { headers?: unknown; rawResponse?: { headers?: unknown } };
  const source = rawResponse?.headers ?? headers;
  if (typeof source !== "object" || source === null) return undefined;
  const get = (source as { get?: unknown }).get;
  return typeof get === "function" ? get.call(source, "x-ratelimit-remaining") : (source as Record<string, unknown>)["x-ratelimit-remaining"];
}

/** GitHub's secondary rate limit can be a 403 whose only sign is its message, in the error text or its body. */
function mentionsRateLimit(error: object): boolean {
  const { message, body } = error as { message?: unknown; body?: unknown };
  const bodyMessage = typeof body === "object" && body !== null ? (body as { message?: unknown }).message : body;
  return [message, bodyMessage].some((text) => typeof text === "string" && /rate limit/i.test(text.slice(0, 4_096)));
}

/** Status of a provider error thrown by the local transport, mapped to an outcome. GitHub's rate limit can be a 403. */
function localFailure(error: unknown): Outcome {
  const status = getErrorStatusCode(error);
  if (status === 429) return retryAfter(getRetryAfterSeconds(error));
  if (status === 403) {
    const seconds = getRetryAfterSeconds(error, 0);
    if (seconds > 0 || rateLimitRemaining(error) === "0" || mentionsRateLimit(error as object)) {
      return retryAfter(seconds > 0 ? seconds : 60);
    }
  }
  if (status === 401 || status === 403) return { status: "unauthorized" };
  if (status === 404 || status === 410) return { status: "not_found" };
  if (status === 400 || status === 422) return { status: "invalid" };
  return UNAVAILABLE;
}

/**
 * A read-call answer other than 2xx. A 401 here is the platform refusing this gateway's machine bearer or delegation
 * proof, never the owner's account, so it is unavailable. The provider's own answer arrives only as a 502 that names
 * it (`upstream`: unauthorized or not_found); any other 502 is unavailable.
 */
async function remoteFailure(response: Response, signal: AbortSignal): Promise<Outcome> {
  const status = response.status;
  // The read-call route answers a missing account with this exact generic message; every other 400 is invalid.
  if (status === 400) {
    const message = await readJsonField(response, "error", signal);
    return message === "Integration account unavailable" ? { status: "not_connected" } : { status: "invalid" };
  }
  if (status === 502) {
    const upstream = await readJsonField(response, "upstream", signal);
    return upstream === "unauthorized" || upstream === "not_found" ? { status: upstream } : UNAVAILABLE;
  }
  discardBody(response);
  if (status === 429) {
    const header = Number(response.headers.get("retry-after"));
    return retryAfter(header > 0 ? header : 60);
  }
  if (status === 401) console.warn("[brain-integration] remote auth rejected");
  if (status === 403 || status === 409 || status === 501) return { status: "invalid" };
  return UNAVAILABLE;
}

/** Headers of a remote read: the machine bearer, the signed owner delegation and the read scope. */
export function brainRemoteIntegrationHeaders(ownerId: string, machineToken: string): Headers {
  return new Headers({
    Authorization: `Bearer ${machineToken}`, Accept: "application/json",
    [INTEGRATION_READ_SCOPE_HEADER]: "read", ...delegatedIntegrationHeaders(ownerId, machineToken),
  });
}

/**
 * The platform user behind an owner id (the request principal: a Clerk id, or the dev principal "default"), looked up
 * by the Clerk id the Settings connect flow stores it under (integrationClerkIdForPrincipal, given `env`); platform
 * rows use UUIDs, so only a UUID-shaped id is also looked up by id. Null when there is none.
 */
export async function findBrainPlatformUser(
  db: Pick<PlatformDb, "getUserByClerkId" | "getUserById">, ownerId: string, env?: IntegrationIdentityEnv,
): Promise<Awaited<ReturnType<PlatformDb["getUserById"]>>> {
  const clerkId = env === undefined ? ownerId : integrationClerkIdForPrincipal(ownerId, env);
  return await db.getUserByClerkId(clerkId)
    ?? (PLATFORM_USER_ID_PATTERN.test(ownerId) ? await db.getUserById(ownerId) : null);
}

/** Which transport a caller with these deps uses: remote is preferred, then local; null answers unavailable. */
export function brainIntegrationTransport(deps: BrainIntegrationCallerDeps): "remote" | "local" | null {
  if (deps.internalBaseUrl && deps.machineToken) return "remote";
  return deps.db && deps.pipedream ? "local" : null;
}

export function createBrainIntegrationCaller(deps: BrainIntegrationCallerDeps): BrainIntegrationCaller {
  const registry: BrainIntegrationRegistry = deps.registry ?? { getService, getAction };
  const timeoutMs = Math.min(Math.max(deps.timeoutMs ?? BRAIN_INTEGRATION_CALL_TIMEOUT_MS, 1), 30_000);
  const fetcher = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const labels = new Map<string, { readonly label: string; readonly expiresAt: number }>();
  const baseUrl = deps.internalBaseUrl ? deps.internalBaseUrl.replace(/\/+$/, "") : null;

  const remoteHeaders = (ownerId: string): Headers => brainRemoteIntegrationHeaders(ownerId, deps.machineToken!);

  async function remoteLabel(ownerId: string, service: string, signal: AbortSignal): Promise<string | Outcome> {
    const key = `${ownerId}\u0000${service}`;
    const cached = labels.get(key);
    if (cached !== undefined && cached.expiresAt > now()) return cached.label;
    labels.delete(key);
    const response = await fetcher(baseUrl!, { headers: remoteHeaders(ownerId), redirect: "error", signal });
    if (!response.ok) return remoteFailure(response, signal);
    const body = await readBoundedJson(response, CONNECTIONS_MAX_BYTES, signal);
    const parsed = body.ok ? ConnectionsSchema.safeParse(body.value) : null;
    if (parsed === null || !parsed.success) return UNAVAILABLE;
    // Never "the first" of several accounts: a run without a pinned label needs the owner's only one.
    const accounts = parsed.data.filter((connection) => connection.service === service);
    if (accounts.length > 1) return { status: "invalid" };
    const label = accounts[0]?.account_label;
    if (label === undefined || !LABEL_PATTERN.test(label)) return { status: "not_connected" };
    if (labels.size >= BRAIN_INTEGRATION_LABEL_CACHE_MAX) labels.delete(labels.keys().next().value!);
    labels.set(key, { label, expiresAt: now() + BRAIN_INTEGRATION_LABEL_CACHE_TTL_MS });
    return label;
  }

  async function remoteCall(ownerId: string, request: BrainIntegrationCallRequest, signal: AbortSignal): Promise<Outcome> {
    const label = request.label ?? await remoteLabel(ownerId, request.service, signal);
    if (typeof label !== "string") return label;
    const headers = remoteHeaders(ownerId);
    headers.set("content-type", "application/json");
    const response = await fetcher(`${baseUrl}/read-call`, {
      method: "POST", headers, redirect: "error", signal,
      body: JSON.stringify({ service: request.service, action: request.action, label, params: request.params }),
    });
    if (!response.ok) return remoteFailure(response, signal);
    const body = await readBoundedJson(response, BRAIN_INTEGRATION_RESPONSE_MAX_BYTES, signal);
    const envelope = body.ok ? EnvelopeSchema.safeParse(body.value) : null;
    if (envelope === null || !envelope.success || envelope.data.action !== request.action) return UNAVAILABLE;
    return { status: "ok", data: envelope.data.data };
  }

  async function localCall(ownerId: string, request: BrainIntegrationCallRequest, signal: AbortSignal): Promise<Outcome> {
    const db = deps.db!;
    const user = await findBrainPlatformUser(db, ownerId, deps.env);
    if (user === null) return { status: "not_connected" };
    const connections = await db.listConnectedServices(user.id);
    // Never "the first" of several accounts: a call without a label needs the owner's only one (as remoteLabel).
    if (request.label === undefined && connections.filter((item) => item.service === request.service).length > 1) {
      return { status: "invalid" };
    }
    const selected = resolveIntegrationConnection(connections, request.service, request.label);
    if (selected.kind === "missing") return { status: "not_connected" };
    if (selected.kind === "ambiguous") return { status: "invalid" };
    if (!user.pipedream_external_id) return UNAVAILABLE;
    signal.throwIfAborted();
    // A byte-capped raw read that the call's signal cancels (never the SDK's buffered parse).
    const { data } = await executeIntegrationAction({
      pipedream: deps.pipedream!, externalUserId: user.pipedream_external_id, connection: selected.connection,
      def: registry.getService(request.service)!, actionDef: registry.getAction(request.service, request.action)!,
      serviceId: request.service, actionId: request.action, params: { ...request.params }, signal,
      maxResponseBytes: BRAIN_INTEGRATION_RESPONSE_MAX_BYTES,
    });
    return { status: "ok", data };
  }

  /**
   * invalid: a bad owner, service, label or parameters (the caller's or the config's fault). unavailable: the
   * registry lacks the service or action, or it is no Pipedream read (a gap in this server, never the owner's config).
   */
  function checkRequest(ownerId: string, request: BrainIntegrationCallRequest): Outcome | null {
    if (!OWNER_ID_PATTERN.test(ownerId)) return { status: "invalid" };
    if (!(BRAIN_INTEGRATION_SERVICES as readonly string[]).includes(request.service)) return { status: "invalid" };
    if (request.label !== undefined && !LABEL_PATTERN.test(request.label)) return { status: "invalid" };
    const service = registry.getService(request.service);
    const action = registry.getAction(request.service, request.action);
    if (service === undefined || action === undefined || action.risk !== "read" || service.connectorKind !== "pipedream") {
      console.warn(`[brain-integration] ${request.service}/${request.action} is not a registered read action`);
      return UNAVAILABLE;
    }
    return validateActionParams(action, { ...request.params }).valid ? null : { status: "invalid" };
  }

  return {
    async call(ownerId, request, signal) {
      signal.throwIfAborted();
      const refused = checkRequest(ownerId, request);
      if (refused !== null) return refused;
      const transport = brainIntegrationTransport(deps);
      if (transport === null) return UNAVAILABLE;
      try {
        return await boundedOperation((bounded) => transport === "local"
          ? localCall(ownerId, request, bounded)
          : remoteCall(ownerId, request, bounded), timeoutMs, signal);
      } catch (error: unknown) {
        if (signal.aborted) throw signal.reason;
        logFailure(transport, request, error);
        if (transport === "local" && !isTimeoutError(error)) return localFailure(error);
        return UNAVAILABLE;
      }
    },
  };
}
