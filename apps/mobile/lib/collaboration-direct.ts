/**
 * Native Mobile client for the direct collaboration transport.
 *
 * Speaks the same wire contract as the web direct client
 * (`packages/ui/src/collaboration/direct-client.ts`) and the CLI transport: the
 * platform issues a short-lived connection ticket at
 * `POST /api/collaboration/connections`, the scope's home exchanges it once for a
 * session bound to an ephemeral Ed25519 proof key, every scope request is signed
 * against that session, and event/terminal sockets open on
 * `/ws/collaboration/direct/scopes/:scopeId/:purpose` with a fresh ticket and a
 * first-frame possession proof. A reconnect never extends a lease.
 *
 * Hermes has no Web Crypto, so signing and hashing use @noble; the proof key lives
 * only in this process's memory, is partitioned by the signed-in actor and is never
 * persisted. The actor bearer is sent only to the platform origin: the platform relay
 * authenticates the actor there and does not forward it to the home.
 */
import {
  COLLABORATION_CLIENT_REQUEST_ID_HEADER,
  COLLABORATION_EXPECTED_MEMBER_REVISION_HEADER,
  COLLABORATION_EXPECTED_REVISION_HEADER,
  CollaborationActorIdSchema,
  CollaborationDeleteConditionSchema,
  CollaborationIdSchema,
  CollaborationRevisionSchema,
} from "@matrix-os/contracts/collaboration";
import {
  COLLABORATION_DIRECT_LIMITS,
  COLLABORATION_DIRECT_PROTOCOL_VERSION,
  CollaborationDirectSessionSchema,
  CollaborationSignedConnectionTicketSchema,
  type CollaborationDirectSession,
  type CollaborationSignedConnectionTicket,
} from "@matrix-os/contracts/collaboration-direct";
import { ed25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha2";
import { z } from "zod/v4";

const REQUEST_TIMEOUT_MS = COLLABORATION_DIRECT_LIMITS.externalApiTimeoutMs;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_SCOPE_SESSIONS = 32;
const MAX_TOKEN_CHARS = 4_096;
const MAX_PATH_CHARS = 1_024;
const MAX_QUERY_CHARS = 512;
const SESSION_HEADER = "x-matrix-collaboration-session";
const REQUEST_HEADER = "x-matrix-collaboration-request";
const RUNTIME_HEADER = "x-matrix-collaboration-runtime";
const POSSESSION_DOMAIN = "matrix-collaboration-possession-v2";
const REQUEST_DOMAIN = "matrix-collaboration-request-v2";
const INVITATION_PATH = /^\/api\/collaboration\/invitations\/[0-9a-f-]{36}(?:\/(?:accept|decline))?$/;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
const MALFORMED_BEARER_ERRORS = new Set(["SyntaxError", "TypeError", "InvalidCharacterError"]);

const IssuedTicketSchema = z.strictObject({
  signedTicket: CollaborationSignedConnectionTicketSchema,
  endpoint: z.strictObject({ origin: z.url(), protocolVersion: z.number().int() }),
});

export type CollaborationDirectMethod = "GET" | "POST" | "PATCH" | "DELETE";
export type CollaborationStreamPurpose = "events" | "terminal";
export type CollaborationDeleteConditions = z.infer<typeof CollaborationDeleteConditionSchema>;
export type CollaborationDirectErrorCode =
  | "upgrade_required" | "host_offline" | "denied" | "not_found" | "invalid_request" | "invalid_response" | "unavailable";

/** Safe, generic client error: never carries provider, host, path, ticket or session detail. */
export class CollaborationDirectError extends Error {
  constructor(public readonly code: CollaborationDirectErrorCode) {
    super("Collaboration unavailable");
    this.name = "CollaborationDirectError";
  }
}

/** Everything a socket needs: the URL, upgrade headers for the platform, and the first frame to send on open. */
export interface CollaborationDirectStream {
  url: string;
  headers: Record<string, string>;
  handshake: string;
}

export interface MobileCollaborationDirectOptions {
  /** The platform origin used for tickets and actor authentication. */
  platformUrl: string;
  /** Cryptographically secure random bytes (expo-crypto on device). */
  randomBytes(length: number): Uint8Array;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

export interface MobileCollaborationDirect {
  request(token: string, scopeId: string, method: CollaborationDirectMethod, path: string, body?: unknown, conditions?: CollaborationDeleteConditions): Promise<unknown>;
  stream(token: string, scopeId: string, purpose: CollaborationStreamPurpose, after: string): Promise<CollaborationDirectStream>;
  /** Drops every cached session and proof key; the homes expire them within the session TTL. */
  close(): void;
}

interface ProofKey { secret: Uint8Array; publicKeyRaw: string }
interface Connected { session: CollaborationDirectSession; origin: string; key: ProofKey }
interface ScopeEntry { key: ProofKey; connected: Connected | null; pending: Promise<Connected> | null }

const encoder = new TextEncoder();

export function createMobileCollaborationDirect(options: MobileCollaborationDirectOptions): MobileCollaborationDirect {
  const platform = requireOrigin(options.platformUrl);
  const now = options.now ?? (() => new Date());
  const scopes = new Map<string, ScopeEntry>();

  const send = async (url: string, init: RequestInit): Promise<Response> => {
    try {
      return await (options.fetchImpl ?? globalThis.fetch)(url, {
        ...init, redirect: "error", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error: unknown) {
      console.warn("[mobile-collaboration-direct] request failed", error instanceof Error ? error.name : "UnknownError");
      throw new CollaborationDirectError("unavailable");
    }
  };

  const random = (length: number): Uint8Array => {
    const bytes = options.randomBytes(length);
    if (bytes.byteLength !== length) throw new CollaborationDirectError("unavailable");
    return bytes;
  };

  const actorHeaders = (origin: string, token: string): Record<string, string> =>
    origin === platform ? { authorization: `Bearer ${token}` } : {};

  /** Platform: a purpose ticket bound to this proof key, for this actor and scope only. */
  const issueTicket = async (token: string, actorId: string, scopeId: string, purpose: "direct_session" | CollaborationStreamPurpose, key: ProofKey) => {
    const response = await send(`${platform}/api/collaboration/connections`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ clientRequestId: uuid(random(16)), scopeId, purpose, proofPublicKey: key.publicKeyRaw }),
    });
    if (response.status === 404 || response.status === 503) {
      await discard(response);
      throw new CollaborationDirectError("host_offline");
    }
    if (response.status === 401 || response.status === 403) {
      await discard(response);
      throw new CollaborationDirectError("denied");
    }
    if (!response.ok) {
      await discard(response);
      throw new CollaborationDirectError("unavailable");
    }
    const raw = await readJson(response);
    // A newer protocol is an upgrade signal before strict parsing rejects the shape.
    const advertised = raw as { endpoint?: { protocolVersion?: unknown }; signedTicket?: { ticket?: { protocolVersion?: unknown } } } | null;
    if ([advertised?.endpoint?.protocolVersion, advertised?.signedTicket?.ticket?.protocolVersion]
      .some((version) => typeof version === "number" && version !== COLLABORATION_DIRECT_PROTOCOL_VERSION)) {
      throw new CollaborationDirectError("upgrade_required");
    }
    const issued = IssuedTicketSchema.safeParse(raw);
    if (!issued.success) throw new CollaborationDirectError("invalid_response");
    const { ticket } = issued.data.signedTicket;
    if (ticket.resource.scopeId !== scopeId || ticket.purpose !== purpose || ticket.actorId !== actorId) {
      throw new CollaborationDirectError("invalid_response");
    }
    return { signedTicket: issued.data.signedTicket, origin: requireOrigin(issued.data.endpoint.origin) };
  };

  const homePost = async (origin: string, token: string, path: string, body: unknown, runtimeId: string): Promise<unknown> => {
    const response = await send(`${origin}${path}`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json", [RUNTIME_HEADER]: runtimeId, ...actorHeaders(origin, token) },
      body: JSON.stringify(body),
    });
    await throwForStatus(response);
    return readJson(response);
  };

  const exchange = async (token: string, actorId: string, scopeId: string, key: ProofKey): Promise<Connected> => {
    const { signedTicket, origin } = await issueTicket(token, actorId, scopeId, "direct_session", key);
    const { ticket } = signedTicket;
    const session = CollaborationDirectSessionSchema.safeParse(await homePost(origin, token, `/api/collaboration/direct-sessions?scope=${scopeId}`, {
      clientRequestId: uuid(random(16)),
      signedTicket,
      proofPublicKey: key.publicKeyRaw,
      possession: sign(key, possessionPayload(ticket.nonce, "direct_session")),
      clientOrigin: platform,
    }, ticket.runtime.runtimeId));
    if (!session.success || session.data.scopeId !== scopeId || session.data.actorId !== actorId
      || session.data.runtimeId !== ticket.runtime.runtimeId) {
      throw new CollaborationDirectError("invalid_response");
    }
    return { session: session.data, origin, key };
  };

  const renew = async (token: string, actorId: string, scopeId: string, current: Connected): Promise<Connected> => {
    const { signedTicket, origin } = await issueTicket(token, actorId, scopeId, "direct_session", current.key);
    if (origin !== current.origin) throw new CollaborationDirectError("invalid_response");
    const session = CollaborationDirectSessionSchema.safeParse(await homePost(
      current.origin, token, `/api/collaboration/direct-sessions/${current.session.id}/renew?scope=${scopeId}`,
      { clientRequestId: uuid(random(16)), signedTicket },
      current.session.runtimeId,
    ));
    if (!session.success || session.data.id !== current.session.id || session.data.actorId !== actorId) {
      throw new CollaborationDirectError("invalid_response");
    }
    return { ...current, session: session.data };
  };

  /** One live session per actor and scope; entries are LRU-capped and fenced by map identity on close. */
  const ensure = async (token: string, actorId: string, scopeId: string, fresh = false): Promise<Connected> => {
    const id = `${actorId}\u0000${scopeId}`;
    let entry = scopes.get(id);
    if (entry) scopes.delete(id);
    else {
      if (scopes.size >= MAX_SCOPE_SESSIONS) scopes.delete(scopes.keys().next().value!);
      entry = { key: proofKey(random(32)), connected: null, pending: null };
    }
    scopes.set(id, entry);
    const current = entry;
    if (current.pending) return current.pending;
    const at = now().getTime();
    const connected = fresh ? null : current.connected;
    if (connected && Date.parse(connected.session.renewAfter) > at && Date.parse(connected.session.expiresAt) > at + 1_000) {
      return connected;
    }
    const pending = (async () => {
      if (connected && Date.parse(connected.session.expiresAt) > at + 1_000) {
        try {
          return await renew(token, actorId, scopeId, connected);
        } catch (error: unknown) {
          if (error instanceof CollaborationDirectError && (error.code === "upgrade_required" || error.code === "host_offline")) throw error;
          // A fresh ticket and session is the bounded recovery path.
          if (!(error instanceof CollaborationDirectError)) {
            console.warn("[mobile-collaboration-direct] session renewal failed", error instanceof Error ? error.name : "UnknownError");
          }
        }
      }
      return exchange(token, actorId, scopeId, current.key);
    })();
    current.pending = pending;
    try {
      const next = await pending;
      if (scopes.get(id) === current) current.connected = next;
      return next;
    } catch (error: unknown) {
      if (scopes.get(id) === current) current.connected = null;
      throw error;
    } finally {
      if (current.pending === pending) current.pending = null;
    }
  };

  const signedFetch = async (
    token: string,
    connected: Connected,
    method: CollaborationDirectMethod,
    path: string,
    query: string,
    body: string | undefined,
    conditions: CollaborationDeleteConditions | undefined,
  ): Promise<Response> => {
    const signature = {
      protocolVersion: COLLABORATION_DIRECT_PROTOCOL_VERSION,
      sessionId: connected.session.id,
      method,
      path,
      query,
      bodyDigest: toHex(sha256(encoder.encode(body ?? ""))),
      conditionalHeadersDigest: toHex(sha256(conditions ? encoder.encode(JSON.stringify(conditions)) : new Uint8Array())),
      nonce: toHex(random(32)),
      issuedAt: now().toISOString(),
    };
    const proof = sign(connected.key, `${REQUEST_DOMAIN}\n${canonicalJson(signature)}`);
    const headers: Record<string, string> = {
      accept: "application/json",
      [SESSION_HEADER]: connected.session.id,
      [RUNTIME_HEADER]: connected.session.runtimeId,
      [REQUEST_HEADER]: toBase64Url(encoder.encode(JSON.stringify({ signature, proof }))),
      ...actorHeaders(connected.origin, token),
    };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (conditions) {
      headers[COLLABORATION_CLIENT_REQUEST_ID_HEADER] = conditions.clientRequestId;
      headers[COLLABORATION_EXPECTED_REVISION_HEADER] = conditions.expectedRevision;
      headers[COLLABORATION_EXPECTED_MEMBER_REVISION_HEADER] = conditions.expectedMemberRevision;
    }
    return send(`${connected.origin}${path}${query ? `?${query}` : ""}`, {
      method, headers, ...(body === undefined ? {} : { body }),
    });
  };

  const request: MobileCollaborationDirect["request"] = async (token, scopeId, method, rawPath, body, conditions) => {
    const actorId = tokenActor(token);
    const scope = requireScopeId(scopeId);
    const { path, query } = splitPath(rawPath, scope);
    const serialized = method === "DELETE" || body === undefined ? undefined : JSON.stringify(body);
    if (serialized !== undefined && encoder.encode(serialized).byteLength > COLLABORATION_DIRECT_LIMITS.httpJsonBytes) {
      throw new CollaborationDirectError("invalid_request");
    }
    let parsedConditions: CollaborationDeleteConditions | undefined;
    if (method === "DELETE" && conditions) {
      const parsed = CollaborationDeleteConditionSchema.safeParse(conditions);
      if (!parsed.success) throw new CollaborationDirectError("invalid_request");
      parsedConditions = parsed.data;
    }
    let connected = await ensure(token, actorId, scope);
    let response = await signedFetch(token, connected, method, path, query, serialized, parsedConditions);
    if (response.status === 401) {
      // The session ended on the home (expiry, denial or a new authority generation): one fresh ticket, one retry.
      await discard(response);
      connected = await ensure(token, actorId, scope, true);
      response = await signedFetch(token, connected, method, path, query, serialized, parsedConditions);
    }
    await throwForStatus(response);
    if (response.status === 204) {
      await discard(response);
      return null;
    }
    return readJson(response);
  };

  const stream: MobileCollaborationDirect["stream"] = async (token, scopeId, purpose, after) => {
    const actorId = tokenActor(token);
    const scope = requireScopeId(scopeId);
    const cursor = CollaborationRevisionSchema.safeParse(after);
    if (!cursor.success) throw new CollaborationDirectError("invalid_request");
    const connected = await ensure(token, actorId, scope);
    const { signedTicket, origin } = await issueTicket(token, actorId, scope, purpose, connected.key);
    if (origin !== connected.origin) throw new CollaborationDirectError("invalid_response");
    const url = new URL(`/ws/collaboration/direct/scopes/${scope}/${purpose}`, origin);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("ticket", toBase64Url(encoder.encode(JSON.stringify(signedTicket))));
    url.searchParams.set("after", cursor.data);
    // The platform authenticates the socket upgrade from the bearer; a separate home origin never sees it.
    const headers: Record<string, string> = origin === platform ? { Authorization: `Bearer ${token}` } : {};
    return { url: url.toString(), headers, handshake: handshakeFrame(connected, signedTicket, purpose) };
  };

  return { request, stream, close: () => { scopes.clear(); } };
}

function handshakeFrame(connected: Connected, signedTicket: CollaborationSignedConnectionTicket, purpose: CollaborationStreamPurpose): string {
  const { nonce } = signedTicket.ticket;
  return JSON.stringify({
    protocolVersion: COLLABORATION_DIRECT_PROTOCOL_VERSION,
    type: "handshake",
    sessionId: connected.session.id,
    ticketNonce: nonce,
    possession: sign(connected.key, possessionPayload(nonce, purpose, connected.session.id)),
  });
}

/**
 * Partitions sessions by the bearer's subject so one account can never reuse
 * another's session in this process. The claim is not trusted for authorization:
 * the platform verifies the bearer and the client also requires the issued ticket
 * to name this same actor.
 */
function tokenActor(token: string): string {
  if (!token || token.length > MAX_TOKEN_CHARS) throw new CollaborationDirectError("denied");
  const payload = token.split(".")[1];
  if (!payload) throw new CollaborationDirectError("denied");
  let subject: unknown;
  try {
    subject = (JSON.parse(new TextDecoder().decode(fromBase64Url(payload))) as { sub?: unknown }).sub;
  } catch (error: unknown) {
    // A malformed bearer (bad base64 or JSON) is an expected denial; anything else is logged.
    if (!(error instanceof Error && MALFORMED_BEARER_ERRORS.has(error.name))) {
      console.warn("[mobile-collaboration-direct] bearer subject unreadable", error instanceof Error ? error.name : "UnknownError");
    }
    throw new CollaborationDirectError("denied");
  }
  const actor = CollaborationActorIdSchema.safeParse(subject);
  if (!actor.success) throw new CollaborationDirectError("denied");
  return actor.data;
}

function requireScopeId(scopeId: string): string {
  const parsed = CollaborationIdSchema.safeParse(scopeId);
  if (!parsed.success) throw new CollaborationDirectError("invalid_request");
  return parsed.data;
}

/** Only the addressed scope's routes and invitation routes may ride a scope session. */
function splitPath(rawPath: string, scopeId: string): { path: string; query: string } {
  if (rawPath.length > MAX_PATH_CHARS || !rawPath.startsWith("/") || rawPath.includes("..")
    || rawPath.includes("//") || rawPath.includes("#")) {
    throw new CollaborationDirectError("invalid_request");
  }
  const separator = rawPath.indexOf("?");
  const path = separator === -1 ? rawPath : rawPath.slice(0, separator);
  const query = separator === -1 ? "" : rawPath.slice(separator + 1);
  const prefix = `/api/collaboration/scopes/${scopeId}`;
  if (query.length > MAX_QUERY_CHARS || !(path === prefix || path.startsWith(`${prefix}/`) || INVITATION_PATH.test(path))) {
    throw new CollaborationDirectError("invalid_request");
  }
  return { path, query };
}

function requireOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error: unknown) {
    if (!(error instanceof TypeError)) console.warn("[mobile-collaboration-direct] origin parse failed", error instanceof Error ? error.name : "UnknownError");
    throw new CollaborationDirectError("invalid_response");
  }
  // The bearer and signed requests only travel in the clear to a loopback development host.
  const tls = url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname.replace(/^\[|\]$/g, "")));
  if (!tls || !url.hostname || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new CollaborationDirectError("invalid_response");
  }
  return url.origin;
}

async function throwForStatus(response: Response): Promise<void> {
  if (response.status >= 200 && response.status < 300) return;
  await discard(response);
  if (response.status === 426) throw new CollaborationDirectError("upgrade_required");
  if (response.status === 401 || response.status === 403) throw new CollaborationDirectError("denied");
  if (response.status === 404) throw new CollaborationDirectError("not_found");
  if (response.status === 409 || response.status === 413 || response.status === 422) throw new CollaborationDirectError("invalid_request");
  throw new CollaborationDirectError("unavailable");
}

async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch (error: unknown) {
    console.warn("[mobile-collaboration-direct] response discard failed", error instanceof Error ? error.name : "UnknownError");
  }
}

async function readJson(response: Response): Promise<unknown> {
  if (!response.headers.get("content-type")?.startsWith("application/json")) {
    await discard(response);
    throw new CollaborationDirectError("invalid_response");
  }
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await discard(response);
    throw new CollaborationDirectError("invalid_response");
  }
  const text = await response.text();
  if (encoder.encode(text).byteLength > MAX_RESPONSE_BYTES) throw new CollaborationDirectError("invalid_response");
  try {
    return JSON.parse(text) as unknown;
  } catch (error: unknown) {
    if (!(error instanceof SyntaxError)) {
      console.warn("[mobile-collaboration-direct] response parse failed", error instanceof Error ? error.name : "UnknownError");
    }
    throw new CollaborationDirectError("invalid_response");
  }
}

function proofKey(secret: Uint8Array): ProofKey {
  return { secret, publicKeyRaw: toBase64Url(ed25519.getPublicKey(secret)) };
}

function sign(key: ProofKey, payload: string): string {
  return toBase64Url(ed25519.sign(encoder.encode(payload), key.secret));
}

function possessionPayload(ticketNonce: string, purpose: string, sessionId = ""): string {
  return `${POSSESSION_DOMAIN}\n${ticketNonce}\n${purpose}\n${sessionId}`;
}

/** Sorted-key JSON, byte-identical to the home's `canonicalJson`. */
function canonicalJson(value: unknown): string {
  const sort = (input: unknown): unknown => Array.isArray(input) ? input.map(sort)
    : input && typeof input === "object"
      ? Object.fromEntries(Object.keys(input as Record<string, unknown>).sort().map((key) => [key, sort((input as Record<string, unknown>)[key])]))
      : input;
  return JSON.stringify(sort(value));
}

function uuid(bytes: Uint8Array): string {
  const value = Uint8Array.from(bytes);
  value[6] = (value[6]! & 0x0f) | 0x40;
  value[8] = (value[8]! & 0x3f) | 0x80;
  const hex = toHex(value);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function toHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
