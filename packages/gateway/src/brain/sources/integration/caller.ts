/**
 * BrainIntegrationCaller over the gateway's integration layer. Two transports, chosen once at construction:
 * - remote: a customer gateway reaches its owner's platform integrations through
 *   POST {internalBaseUrl}/read-call with the machine bearer and signed owner delegation (the same path the Jev
 *   read client uses). That route needs an account label, so a call without one first reads the owner's
 *   connections (GET {internalBaseUrl}) and takes the service's only one (several: invalid), cached briefly.
 * - local: a gateway that holds the platform database and Pipedream client (and no remote transport) runs
 *   executeIntegrationAction itself, for the platform user whose Clerk id (or platform id) is the owner id, as a
 *   byte-capped raw read (pipedream.boundedProxy) that the call's signal cancels.
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
