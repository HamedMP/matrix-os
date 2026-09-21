/**
 * Shared direct transport client (S06 / T031).
 *
 * Every scope has one authoritative home. The client asks the platform for a
 * short-lived connection ticket, dials the origin the resource directory
 * returned (never a hardcoded one; in this release the platform relay),
 * exchanges the ticket once for a home session with Web Crypto proof of
 * possession, signs every request against that session, renews before the
 * five-minute cap and reconnects with a fresh ticket. A reconnect never
 * extends a lease; the platform is never consulted for authorization.
 * Errors are typed and generic. Nothing reusable is written to storage.
 */
import {
  COLLABORATION_CLIENT_REQUEST_ID_HEADER,
  COLLABORATION_DIRECT_LIMITS,
  COLLABORATION_DIRECT_PROTOCOL_VERSION,
  COLLABORATION_EXPECTED_MEMBER_REVISION_HEADER,
  COLLABORATION_EXPECTED_REVISION_HEADER,
  CollaborationDirectSessionSchema,
  CollaborationOwnerRuntimeSessionSchema,
  CollaborationSignedOwnerRuntimeTicketSchema,
  CollaborationOrganizationIdSchema,
  CollaborationRuntimeIdSchema,
  CollaborationSignedConnectionTicketSchema,
  toLogicalRuntimeId,
  type CollaborationDirectSession,
  type CollaborationOwnerRuntimeSession,
} from "@matrix-os/contracts";
import { z } from "zod/v4";
import {
  generateProofKey,
  possessionPayload,
  randomHex,
  randomId,
  requestSigningPayload,
  sha256Hex,
  signPayload,
  toBase64Url,
  type ProofKeyPair,
} from "./direct-crypto.js";
import { createDirectStreams, type DirectEventHandlers, type DirectTerminalHandlers } from "./direct-streams.js";

const REQUEST_TIMEOUT_MS = COLLABORATION_DIRECT_LIMITS.externalApiTimeoutMs;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_SCOPE_RECORDS = 128;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SESSION_HEADER = "x-matrix-collaboration-session";
const REQUEST_HEADER = "x-matrix-collaboration-request";

const IssuedTicketSchema = z.object({
  signedTicket: CollaborationSignedConnectionTicketSchema,
  endpoint: z.object({ origin: z.string().url(), protocolVersion: z.number().int() }).strict(),
}).strict();
const IssuedOwnerRuntimeTicketSchema = z.object({
  signedTicket: CollaborationSignedOwnerRuntimeTicketSchema,
  endpoint: z.object({ origin: z.string().url(), protocolVersion: z.number().int() }).strict(),
}).strict();

export type CollaborationDirectErrorCode =
  | "upgrade_required" | "host_offline" | "denied" | "unavailable" | "not_found" | "invalid_request" | "invalid_response";

/** Safe, generic client error: never carries provider, host or path detail. */
export class CollaborationDirectError extends Error {
  constructor(public readonly code: CollaborationDirectErrorCode, message = "Collaboration unavailable") {
    super(message);
    this.name = "CollaborationDirectError";
  }
}

export type DirectScopeState = "idle" | "connecting" | "connected" | "offline" | "upgrade_required" | "denied";
export type DirectMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export interface DirectDeleteConditions { clientRequestId: string; expectedRevision: string; expectedMemberRevision: string }

export type { DirectEventHandlers, DirectTerminalHandlers } from "./direct-streams.js";

export interface CollaborationDirectClientOptions {
  /** The platform origin used for identity, discovery and ticket issuance. */
  platformBaseUrl: string;
  fetchImpl?: typeof fetch;
  /** Actor authentication for platform calls only; never sent to a home. */
  getHeaders?: () => Promise<Record<string, string>>;
  webSocketFactory?: (url: string) => WebSocket;
  /** The origin this client runs on; the home checks it against its allowlist. */
  clientOrigin?: string;
  subtle?: SubtleCrypto;
  now?: () => Date;
}

export interface CollaborationDirectClient {
  request(scopeId: string, method: DirectMethod, path: string, body?: unknown, conditions?: DirectDeleteConditions): Promise<unknown>;
  requestOwnerRuntime(runtimeId: string, organizationId: string, path: string, body: unknown): Promise<unknown>;
  requestOwnerProject(runtimeId: string, organizationId: string, method: "GET" | "POST", path: string, body?: unknown): Promise<unknown>;
  subscribeEvents(scopeId: string, handlers: DirectEventHandlers): () => void;
  subscribeTerminal(scopeId: string, handlers: DirectTerminalHandlers): () => void;
  describe(scopeId: string): { state: DirectScopeState; origin: string | null; expiresAt: string | null };
  /** Closes one scope's session (or all) on the home, best effort. */
  close(scopeId?: string): void;
  /** Test seam: the in-memory proof key for a scope; the private key is not extractable. */
  inspectKeys(scopeId: string): ProofKeyPair | null;
}

export interface DirectConnected { session: CollaborationDirectSession; origin: string; key: ProofKeyPair }
type Connected = DirectConnected;

interface ScopeRecord {
  state: DirectScopeState;
  connected: Connected | null;
  pending: Promise<Connected> | null;
  key: ProofKeyPair | null;
  generation: number;
}
interface OwnerRuntimeRecord {
  connected: { session: CollaborationOwnerRuntimeSession; origin: string; key: ProofKeyPair } | null;
  pending: Promise<{ session: CollaborationOwnerRuntimeSession; origin: string; key: ProofKeyPair }> | null;
  key: ProofKeyPair | null;
}

export function createCollaborationDirectClient(options: CollaborationDirectClientOptions): CollaborationDirectClient {
  const platform = requireOrigin(options.platformBaseUrl);
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => new Date());
  const clientOrigin = options.clientOrigin ?? globalThis.location?.origin ?? platform.origin;
  const scopes = new Map<string, ScopeRecord>();
  let disposed = false;
  const ownerRuntimes = new Map<string, OwnerRuntimeRecord>();

  const record = (scopeId: string): ScopeRecord => {
    if (disposed) throw new CollaborationDirectError("denied", "Collaboration session closed");
    let entry = scopes.get(scopeId);
    if (!entry) {
      if (scopes.size >= MAX_SCOPE_RECORDS) {
        const oldest = scopes.keys().next().value;
        if (oldest) closeScope(oldest);
      }
      entry = { state: "idle", connected: null, pending: null, key: null, generation: 0 };
      scopes.set(scopeId, entry);
    }
    return entry;
  };

  const platformHeaders = async (): Promise<Headers> => {
    const provided = await options.getHeaders?.();
    const headers = new Headers({ accept: "application/json", "content-type": "application/json" });
    const authorization = provided?.Authorization ?? provided?.authorization;
    if (authorization && authorization.length <= 4_096) headers.set("authorization", authorization);
    return headers;
  };

  /** Platform: `POST /api/collaboration/connections`. A 404/503 means the home is unreachable or the scope is unknown. */
  const issueTicket = async (scopeId: string, purpose: "direct_session" | "events" | "terminal", key: ProofKeyPair) => {
    const response = await guardedFetch(fetchImpl, new URL("/api/collaboration/connections", platform).href, {
      method: "POST",
      headers: await platformHeaders(),
      credentials: "same-origin",
      redirect: "error",
      body: JSON.stringify({ clientRequestId: randomId(), scopeId, purpose, proofPublicKey: key.publicKeyRaw }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (response.status === 404 || response.status === 503) {
      await response.body?.cancel();
      throw new CollaborationDirectError("host_offline", "Collaboration home is unavailable");
    }
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel();
      throw new CollaborationDirectError("denied", "Collaboration request denied");
    }
    const raw = await readJson(response);
    // A newer platform protocol is an upgrade signal before any strict parsing rejects it.
    const advertised = (raw as { endpoint?: { protocolVersion?: unknown }; signedTicket?: { ticket?: { protocolVersion?: unknown } } } | null);
    const versions = [advertised?.endpoint?.protocolVersion, advertised?.signedTicket?.ticket?.protocolVersion];
    if (versions.some((version) => typeof version === "number" && version !== COLLABORATION_DIRECT_PROTOCOL_VERSION)) {
      throw new CollaborationDirectError("upgrade_required", "Collaboration client update required");
    }
    const issued = IssuedTicketSchema.safeParse(raw);
    if (!issued.success) throw new CollaborationDirectError("invalid_response");
    if (issued.data.signedTicket.ticket.resource.scopeId !== scopeId) throw new CollaborationDirectError("invalid_response");
    return { signedTicket: issued.data.signedTicket, origin: requireOrigin(issued.data.endpoint.origin).origin };
  };

  const homeJson = async (origin: string, path: string, query: string, body: unknown): Promise<unknown> => {
    const url = new URL(path, origin);
    url.search = query;
    const response = await guardedFetch(fetchImpl, url.href, {
      method: "POST",
      headers: new Headers({ accept: "application/json", "content-type": "application/json" }),
      credentials: "omit",
      redirect: "error",
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    throwForStatus(response.status);
    return readJson(response);
  };

  const exchange = async (scopeId: string, key: ProofKeyPair): Promise<Connected> => {
    const { signedTicket, origin } = await issueTicket(scopeId, "direct_session", key);
    const possession = await signPayload(key, possessionPayload({ ticketNonce: signedTicket.ticket.nonce, purpose: "direct_session" }), options.subtle);
    const session = CollaborationDirectSessionSchema.safeParse(await homeJson(origin, "/api/collaboration/direct-sessions", `scope=${scopeId}`, {
      clientRequestId: randomId(), signedTicket, proofPublicKey: key.publicKeyRaw, possession, clientOrigin,
    }));
    if (!session.success || session.data.scopeId !== scopeId) throw new CollaborationDirectError("invalid_response");
    return { session: session.data, origin, key };
  };

  const exchangeOwnerRuntime = async (runtimeId: string, organizationId: string, key: ProofKeyPair): Promise<NonNullable<OwnerRuntimeRecord["connected"]>> => {
    const response = await guardedFetch(fetchImpl, new URL("/api/collaboration/owner-runtime/connections", platform).href, {
      method: "POST", headers: await platformHeaders(), credentials: "same-origin", redirect: "error",
      body: JSON.stringify({ clientRequestId: randomId(), runtimeId, organizationId, proofPublicKey: key.publicKeyRaw }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    throwForStatus(response.status);
    const raw = await readJson(response);
    const advertised = (raw as { endpoint?: { protocolVersion?: unknown }; signedTicket?: { ticket?: { protocolVersion?: unknown } } } | null);
    if ([advertised?.endpoint?.protocolVersion, advertised?.signedTicket?.ticket?.protocolVersion]
      .some((version) => typeof version === "number" && version !== COLLABORATION_DIRECT_PROTOCOL_VERSION)) {
      throw new CollaborationDirectError("upgrade_required", "Collaboration client update required");
    }
    const issued = IssuedOwnerRuntimeTicketSchema.safeParse(raw);
    // The same canonicalization the platform and the home apply: only a VPS
    // enrollment id is rewritten, so a logical runtime id keeps its case.
    const logicalRuntimeId = toLogicalRuntimeId(runtimeId);
    if (!issued.success || issued.data.signedTicket.ticket.organizationId !== organizationId
      || issued.data.signedTicket.ticket.runtime.runtimeId !== logicalRuntimeId) throw new CollaborationDirectError("invalid_response");
    const { signedTicket } = issued.data;
    const origin = requireOrigin(issued.data.endpoint.origin).origin;
    const possession = await signPayload(key, possessionPayload({ ticketNonce: signedTicket.ticket.nonce, purpose: "owner_runtime" }), options.subtle);
    const session = CollaborationOwnerRuntimeSessionSchema.safeParse(await homeJson(origin, "/api/collaboration/owner-runtime/sessions", "", {
      clientRequestId: randomId(), signedTicket, proofPublicKey: key.publicKeyRaw, possession, clientOrigin,
    }));
    if (!session.success || session.data.organizationId !== organizationId || session.data.runtimeId !== logicalRuntimeId) {
      throw new CollaborationDirectError("invalid_response");
    }
    return { session: session.data, origin, key };
  };

  const renew = async (scopeId: string, current: Connected): Promise<Connected> => {
    const { signedTicket } = await issueTicket(scopeId, "direct_session", current.key);
    const session = CollaborationDirectSessionSchema.safeParse(await homeJson(
      current.origin, `/api/collaboration/direct-sessions/${current.session.id}/renew`, `scope=${scopeId}`,
      { clientRequestId: randomId(), signedTicket },
    ));
    if (!session.success || session.data.id !== current.session.id) throw new CollaborationDirectError("invalid_response");
    return { ...current, session: session.data };
  };

  const closedError = () => new CollaborationDirectError("denied", "Collaboration session closed");

  /** A close increments the record generation, fencing every pending exchange or renewal. */
  const ensure = async (scopeId: string, fresh = false): Promise<Connected> => {
    if (disposed) throw closedError();
    const entry = record(scopeId);
    if (entry.pending) return entry.pending;
    const generation = entry.generation;
    const active = () => !disposed && scopes.get(scopeId) === entry && entry.generation === generation;
    const current = entry.connected;
    const at = now().getTime();
    if (current && !fresh && Date.parse(current.session.expiresAt) > at + 1_000
      && Date.parse(current.session.renewAfter) > at) return current;

    const connectFresh = async (): Promise<Connected> => {
      entry.key ??= await generateProofKey(options.subtle);
      if (!active()) throw closedError();
      const connected = await exchange(scopeId, entry.key);
      if (!active()) {
        closeConnected(scopeId, connected);
        throw closedError();
      }
      entry.connected = connected;
      entry.state = "connected";
      return connected;
    };
    const connect = async (): Promise<Connected> => {
      try {
        if (current && !fresh && Date.parse(current.session.expiresAt) > at + 1_000) {
          try {
            const renewed = await renew(scopeId, current);
            if (!active()) throw closedError();
            entry.connected = renewed;
            entry.state = "connected";
            return renewed;
          } catch (error: unknown) {
            if (!active()) throw closedError();
            if (error instanceof CollaborationDirectError && (error.code === "upgrade_required" || error.code === "host_offline")) throw error;
          }
        }
        if (!active()) throw closedError();
        entry.connected = null;
        return await connectFresh();
      } catch (error: unknown) {
        if (active()) {
          entry.connected = null;
          entry.state = error instanceof CollaborationDirectError
            ? error.code === "host_offline" ? "offline" : error.code === "upgrade_required" ? "upgrade_required" : error.code === "denied" ? "denied" : "idle"
            : "idle";
        }
        throw error;
      }
    };
    entry.state = "connecting";
    const pending = connect();
    entry.pending = pending;
    const clearPending = () => { if (entry.pending === pending) entry.pending = null; };
    void pending.then(clearPending, clearPending);
    return pending;
  };

  const ensureOwnerRuntime = async (runtimeId: string, organizationId: string, fresh = false): Promise<NonNullable<OwnerRuntimeRecord["connected"]>> => {
    const id = `${runtimeId}\u0000${organizationId}`;
    let entry = ownerRuntimes.get(id);
    if (!entry) {
      if (ownerRuntimes.size >= 16) ownerRuntimes.delete(ownerRuntimes.keys().next().value!);
      entry = { connected: null, pending: null, key: null };
    } else ownerRuntimes.delete(id);
    ownerRuntimes.set(id, entry);
    if (entry.pending) return entry.pending;
    if (entry.connected && !fresh && Date.parse(entry.connected.session.renewAfter) > now().getTime()) return entry.connected;
    entry.pending = (async () => {
      entry!.key ??= await generateProofKey(options.subtle);
      const connected = await exchangeOwnerRuntime(runtimeId, organizationId, entry!.key);
      entry!.connected = connected;
      return connected;
    })().catch((error: unknown) => { entry!.connected = null; throw error; }).finally(() => { entry!.pending = null; });
    return entry.pending;
  };

  const signedFetch = async (_scopeId: string, connected: { session: { id: string }; origin: string; key: ProofKeyPair }, method: DirectMethod, path: string, query: string, body: string | undefined, conditions?: DirectDeleteConditions, ownerProject = false) => {
    const bodyBytes = new TextEncoder().encode(body ?? "");
    const conditional = conditions
      ? new TextEncoder().encode(JSON.stringify({ clientRequestId: conditions.clientRequestId, expectedRevision: conditions.expectedRevision, expectedMemberRevision: conditions.expectedMemberRevision }))
      : new Uint8Array();
    const signature = {
      protocolVersion: COLLABORATION_DIRECT_PROTOCOL_VERSION,
      sessionId: connected.session.id,
      method,
      path,
      query,
      bodyDigest: await sha256Hex(bodyBytes, options.subtle),
      conditionalHeadersDigest: await sha256Hex(conditional, options.subtle),
      nonce: randomHex(),
      issuedAt: now().toISOString(),
    };
    const proof = await signPayload(connected.key, requestSigningPayload(signature), options.subtle);
    const headers = new Headers({ accept: "application/json" });
    if (body !== undefined) headers.set("content-type", "application/json");
    headers.set(SESSION_HEADER, connected.session.id);
    headers.set(REQUEST_HEADER, toBase64Url(new TextEncoder().encode(JSON.stringify({ signature, proof }))));
    if (ownerProject) headers.set("x-matrix-collaboration-owner-runtime", "1");
    if (conditions) {
      headers.set(COLLABORATION_CLIENT_REQUEST_ID_HEADER, conditions.clientRequestId);
      headers.set(COLLABORATION_EXPECTED_REVISION_HEADER, conditions.expectedRevision);
      headers.set(COLLABORATION_EXPECTED_MEMBER_REVISION_HEADER, conditions.expectedMemberRevision);
    }
    const url = new URL(path, connected.origin);
    url.search = query;
    return guardedFetch(fetchImpl, url.href, {
      method, headers, credentials: "omit", redirect: "error",
      ...(body === undefined ? {} : { body }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  };

  const closeConnected = (scopeId: string, connected: Connected) => {
    void signedFetch(scopeId, connected, "DELETE", `/api/collaboration/direct-sessions/${connected.session.id}`, "", undefined)
      .then((response) => response.body?.cancel())
      .catch((error: unknown) => { console.warn("[collaboration-direct] session close failed", error instanceof Error ? error.name : "UnknownError"); });
  };

  const request: CollaborationDirectClient["request"] = async (scopeId, method, rawPath, body, conditions) => {
    if (!UUID.test(scopeId)) throw new CollaborationDirectError("invalid_request", "Invalid collaboration request");
    const { path, query } = splitPath(rawPath, scopeId);
    const serialized = method === "DELETE" || body === undefined ? undefined : JSON.stringify(body);
    if (serialized !== undefined && new TextEncoder().encode(serialized).byteLength > COLLABORATION_DIRECT_LIMITS.httpJsonBytes) {
      throw new CollaborationDirectError("invalid_request", "Invalid collaboration request");
    }
    const initial = record(scopeId);
    const generation = initial.generation;
    let connected = await ensure(scopeId);
    if (disposed || initial.generation !== generation) throw closedError();
    let response = await signedFetch(scopeId, connected, method, path, query, serialized, conditions);
    if (disposed || initial.generation !== generation) { await response.body?.cancel(); throw closedError(); }
    if (response.status === 401) {
      // The session ended on the home (expiry, denial or a new authority generation): one fresh ticket, one retry.
      await response.body?.cancel();
      const entry = record(scopeId);
      entry.connected = null;
      connected = await ensure(scopeId, true);
      response = await signedFetch(scopeId, connected, method, path, query, serialized, conditions);
      if (disposed || initial.generation !== generation) { await response.body?.cancel(); throw closedError(); }
    }
    throwForStatus(response.status);
    if (response.status === 204) {
      await response.body?.cancel();
      return null;
    }
    return readJson(response);
  };

  const requestOwnerRuntime: CollaborationDirectClient["requestOwnerRuntime"] = async (runtimeId, organizationId, path, body) => {
    if (!CollaborationRuntimeIdSchema.safeParse(runtimeId).success || !CollaborationOrganizationIdSchema.safeParse(organizationId).success
      || !body || typeof body !== "object" || (body as { organizationId?: unknown }).organizationId !== organizationId) {
      throw new CollaborationDirectError("invalid_request", "Invalid collaboration request");
    }
    const prefix = `/api/collaboration/runtimes/${encodeURIComponent(runtimeId)}`;
    if (![`${prefix}/catalog/resolve`, `${prefix}/scopes/preflight`, `${prefix}/scopes`].includes(path)) {
      throw new CollaborationDirectError("invalid_request", "Invalid collaboration request");
    }
    const serialized = JSON.stringify(body);
    if (new TextEncoder().encode(serialized).byteLength > COLLABORATION_DIRECT_LIMITS.httpJsonBytes) {
      throw new CollaborationDirectError("invalid_request", "Invalid collaboration request");
    }
    let connected = await ensureOwnerRuntime(runtimeId, organizationId);
    let response = await signedFetch(runtimeId, connected, "POST", path, "", serialized);
    if (response.status === 401) {
      await response.body?.cancel();
      connected = await ensureOwnerRuntime(runtimeId, organizationId, true);
      response = await signedFetch(runtimeId, connected, "POST", path, "", serialized);
    }
    throwForStatus(response.status);
    if (response.status === 204) { await response.body?.cancel(); return null; }
    return readJson(response);
  };

  const requestOwnerProject: CollaborationDirectClient["requestOwnerProject"] = async (runtimeId, organizationId, method, path, body) => {
    if (!CollaborationRuntimeIdSchema.safeParse(runtimeId).success || !CollaborationOrganizationIdSchema.safeParse(organizationId).success) {
      throw new CollaborationDirectError("invalid_request", "Invalid collaboration request");
    }
    const project = /^\/api\/collaboration\/scopes\/([0-9a-f-]{36})(?:\/(members|project\/inventory|project\/confirm))?$/.exec(path);
    if (!project || !UUID.test(project[1]!) || (project[2] === "project/confirm" ? method !== "POST" : method !== "GET")
      || (method === "GET" && body !== undefined) || (method === "POST" && (body === undefined || typeof body !== "object"))) {
      throw new CollaborationDirectError("invalid_request", "Invalid collaboration request");
    }
    const serialized = body === undefined ? undefined : JSON.stringify(body);
    if (serialized !== undefined && new TextEncoder().encode(serialized).byteLength > COLLABORATION_DIRECT_LIMITS.httpJsonBytes) {
      throw new CollaborationDirectError("invalid_request", "Invalid collaboration request");
    }
    let connected = await ensureOwnerRuntime(runtimeId, organizationId);
    let response = await signedFetch(runtimeId, connected, method, path, "", serialized, undefined, true);
    if (response.status === 401) {
      await response.body?.cancel();
      connected = await ensureOwnerRuntime(runtimeId, organizationId, true);
      response = await signedFetch(runtimeId, connected, method, path, "", serialized, undefined, true);
    }
    throwForStatus(response.status);
    return readJson(response);
  };

  const streams = createDirectStreams({
    ensure,
    issueTicket: (scopeId, purpose, key) => issueTicket(scopeId, purpose, key),
    subtle: options.subtle,
    webSocketFactory: options.webSocketFactory,
  });

  const closeScope = (scopeId: string) => {
    streams.closeScope(scopeId);
    const entry = scopes.get(scopeId);
    if (!entry) return;
    entry.generation += 1;
    const connected = entry.connected;
    entry.connected = null;
    entry.pending = null;
    entry.key = null;
    entry.state = "idle";
    scopes.delete(scopeId);
    if (connected) closeConnected(scopeId, connected);
  };

  return {
    request,
    requestOwnerRuntime,
    requestOwnerProject,
    subscribeEvents: streams.subscribeEvents,
    subscribeTerminal: streams.subscribeTerminal,
    describe: (scopeId) => {
      const entry = scopes.get(scopeId);
      return { state: entry?.state ?? "idle", origin: entry?.connected?.origin ?? null, expiresAt: entry?.connected?.session.expiresAt ?? null };
    },
    close: (scopeId) => {
      if (scopeId) closeScope(scopeId);
      else {
        disposed = true;
        streams.closeAll();
        for (const id of [...scopes.keys()]) closeScope(id);
        ownerRuntimes.clear();
      }
    },
    inspectKeys: (scopeId) => scopes.get(scopeId)?.key ?? null,
  };
}

function splitPath(rawPath: string, scopeId: string): { path: string; query: string } {
  if (rawPath.length > 1_024 || rawPath.includes("..") || rawPath.includes("//") || rawPath.includes("#")) {
    throw new CollaborationDirectError("invalid_request", "Invalid collaboration request");
  }
  const [path = "", query = ""] = rawPath.split("?", 2);
  const scopePrefix = `/api/collaboration/scopes/${scopeId}`;
  const scoped = path === scopePrefix || path.startsWith(`${scopePrefix}/`);
  const invitation = /^\/api\/collaboration\/invitations\/[0-9a-f-]{36}(?:\/(?:accept|decline))?$/.test(path);
  if (!scoped && !invitation) throw new CollaborationDirectError("invalid_request", "Invalid collaboration request");
  return { path, query };
}

function requireOrigin(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error: unknown) {
    if (!(error instanceof TypeError)) console.warn("[collaboration-direct] origin parse failed", error instanceof Error ? error.name : "UnknownError");
    throw new CollaborationDirectError("invalid_response");
  }
  if (!url.hostname || !["https:", "http:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new CollaborationDirectError("invalid_response");
  }
  return url;
}

async function guardedFetch(fetchImpl: typeof fetch, url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetchImpl(url, init);
  } catch (error: unknown) {
    console.warn("[collaboration-direct] request failed", error instanceof Error ? error.name : "UnknownError");
    throw new CollaborationDirectError("unavailable");
  }
}

function throwForStatus(status: number): void {
  if (status >= 200 && status < 300) return;
  if (status === 426) throw new CollaborationDirectError("upgrade_required", "Collaboration client update required");
  if (status === 401 || status === 403) throw new CollaborationDirectError("denied", "Collaboration request denied");
  if (status === 404) throw new CollaborationDirectError("not_found", "Collaboration resource not found");
  if (status === 409 || status === 413 || status === 422) throw new CollaborationDirectError("invalid_request", "Collaboration state changed");
  throw new CollaborationDirectError("unavailable");
}

async function readJson(response: Response): Promise<unknown> {
  if (!response.headers.get("content-type")?.startsWith("application/json")) {
    await response.body?.cancel();
    throw new CollaborationDirectError("invalid_response");
  }
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new CollaborationDirectError("invalid_response");
  }
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) throw new CollaborationDirectError("invalid_response");
  try {
    return JSON.parse(text) as unknown;
  } catch (error: unknown) {
    if (!(error instanceof SyntaxError)) console.warn("[collaboration-direct] response parse failed", error instanceof Error ? error.name : "UnknownError");
    throw new CollaborationDirectError("invalid_response");
  }
}
