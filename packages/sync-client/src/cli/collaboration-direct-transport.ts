/** 525 CLI compatibility over the v2 owner-home collaboration protocol. No keys or sessions are persisted. */
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign, type KeyObject } from "node:crypto";
import {
  COLLABORATION_DIRECT_LIMITS, COLLABORATION_DIRECT_PROTOCOL_VERSION,
  CollaborationDirectSessionSchema, CollaborationSignedConnectionTicketSchema,
} from "@matrix-os/contracts";
import { z } from "zod/v4";

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_SCOPES = 32;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TicketResponse = z.object({
  signedTicket: CollaborationSignedConnectionTicketSchema,
  endpoint: z.object({ origin: z.url(), protocolVersion: z.number().int() }).strict(),
}).strict();

type Method = "GET" | "POST" | "PATCH";
type TicketPurpose = "direct_session" | "terminal";
type Key = { privateKey: KeyObject; publicKeyRaw: string };
type Connected = { session: z.infer<typeof CollaborationDirectSessionSchema>; origin: string; key: Key };
type Entry = { connected: Connected | null; pending: Promise<Connected> | null; key: Key };

export interface CliCollaborationTransportOptions {
  platformUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  clientOrigin?: string;
}

function unavailable(): Error { return new Error("Collaboration request failed"); }
function digest(bytes: Uint8Array | string): string { return createHash("sha256").update(bytes).digest("hex"); }
function b64json(value: unknown): string { return Buffer.from(JSON.stringify(value)).toString("base64url"); }
function canonical(value: unknown): string {
  const sort = (input: unknown): unknown => Array.isArray(input) ? input.map(sort)
    : input && typeof input === "object" ? Object.fromEntries(Object.keys(input as Record<string, unknown>).sort()
      .map((key) => [key, sort((input as Record<string, unknown>)[key])])) : input;
  return JSON.stringify(sort(value));
}
function proof(key: Key, payload: string): string { return sign(null, Buffer.from(payload), key.privateKey).toString("base64url"); }
function keyPair(): Key {
  const pair = generateKeyPairSync("ed25519");
  const spki = pair.publicKey.export({ format: "der", type: "spki" });
  return { privateKey: pair.privateKey, publicKeyRaw: spki.subarray(-32).toString("base64url") };
}
function origin(value: string): string {
  const url = new URL(value);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw unavailable();
  return url.origin;
}
async function boundedJson(response: Response): Promise<unknown> {
  if (!response.ok) { await response.body?.cancel(); throw unavailable(); }
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) { await response.body?.cancel(); throw unavailable(); }
  const reader = response.body?.getReader();
  if (!reader) throw unavailable();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw unavailable();
      parts.push(value);
    }
  } catch (error: unknown) {
    await reader.cancel().catch((cleanupError: unknown) => {
      console.warn("[cli-collaboration] response cleanup failed", cleanupError instanceof Error ? cleanupError.name : "UnknownError");
    });
    throw error;
  } finally { reader.releaseLock(); }
  const bytes = Buffer.concat(parts, size);
  try { return JSON.parse(bytes.toString("utf8")) as unknown; }
  catch (error: unknown) {
    if (!(error instanceof SyntaxError)) console.warn("[cli-collaboration] response parse failed", error instanceof Error ? error.name : "UnknownError");
    throw unavailable();
  }
}

export function createCliCollaborationTransport(options: CliCollaborationTransportOptions) {
  const platform = origin(options.platformUrl);
  const clientOrigin = origin(options.clientOrigin ?? platform);
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => new Date());
  const scopes = new Map<string, Entry>();

  const entry = (scopeId: string): Entry => {
    let current = scopes.get(scopeId);
    if (current) scopes.delete(scopeId);
    else current = { connected: null, pending: null, key: keyPair() };
    if (scopes.size >= MAX_SCOPES) scopes.delete(scopes.keys().next().value!);
    scopes.set(scopeId, current);
    return current;
  };

  const issueTicket = async (scopeId: string, purpose: TicketPurpose, key: Key) => {
    const response = await fetchImpl(`${platform}/api/collaboration/connections`, {
      method: "POST", headers: { authorization: `Bearer ${options.token}`, accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ clientRequestId: randomUUID(), scopeId, purpose, proofPublicKey: key.publicKeyRaw }),
      redirect: "error", signal: AbortSignal.timeout(COLLABORATION_DIRECT_LIMITS.externalApiTimeoutMs),
    });
    const raw = await boundedJson(response);
    const advertised = raw as { endpoint?: { protocolVersion?: unknown }; signedTicket?: { ticket?: { protocolVersion?: unknown } } };
    if ([advertised?.endpoint?.protocolVersion, advertised?.signedTicket?.ticket?.protocolVersion]
      .some((version) => typeof version === "number" && version !== COLLABORATION_DIRECT_PROTOCOL_VERSION)) throw unavailable();
    const parsed = TicketResponse.safeParse(raw);
    if (!parsed.success || parsed.data.signedTicket.ticket.resource.scopeId !== scopeId
      || parsed.data.signedTicket.ticket.purpose !== purpose) throw unavailable();
    return { ...parsed.data, origin: origin(parsed.data.endpoint.origin) };
  };

  const homePost = async (home: string, path: string, body: unknown, runtimeId: string) => boundedJson(await fetchImpl(`${home}${path}`, {
    method: "POST", headers: { accept: "application/json", "content-type": "application/json",
      "x-matrix-collaboration-runtime": runtimeId },
    body: JSON.stringify(body), redirect: "error", signal: AbortSignal.timeout(COLLABORATION_DIRECT_LIMITS.externalApiTimeoutMs),
  }));

  const connect = async (scopeId: string, key: Key): Promise<Connected> => {
    const issued = await issueTicket(scopeId, "direct_session", key);
    const ticket = issued.signedTicket.ticket;
    const possession = proof(key, `matrix-collaboration-possession-v2\n${ticket.nonce}\ndirect_session\n`);
    const raw = await homePost(issued.origin, `/api/collaboration/direct-sessions?scope=${scopeId}`, {
      clientRequestId: randomUUID(), signedTicket: issued.signedTicket, proofPublicKey: key.publicKeyRaw, possession, clientOrigin,
    }, ticket.runtime.runtimeId);
    const session = CollaborationDirectSessionSchema.safeParse(raw);
    if (!session.success || session.data.scopeId !== scopeId) throw unavailable();
    return { session: session.data, origin: issued.origin, key };
  };

  const renew = async (scopeId: string, current: Connected): Promise<Connected> => {
    const issued = await issueTicket(scopeId, "direct_session", current.key);
    if (issued.origin !== current.origin) throw unavailable();
    const raw = await homePost(current.origin, `/api/collaboration/direct-sessions/${current.session.id}/renew?scope=${scopeId}`, {
      clientRequestId: randomUUID(), signedTicket: issued.signedTicket,
    }, issued.signedTicket.ticket.runtime.runtimeId);
    const session = CollaborationDirectSessionSchema.safeParse(raw);
    if (!session.success || session.data.id !== current.session.id) throw unavailable();
    return { ...current, session: session.data };
  };

  const ensure = async (scopeId: string, fresh = false): Promise<Connected> => {
    if (!UUID.test(scopeId)) throw unavailable();
    const state = entry(scopeId);
    if (state.pending) return state.pending;
    const current = state.connected;
    const at = now().getTime();
    if (current && !fresh && Date.parse(current.session.renewAfter) > at && Date.parse(current.session.expiresAt) > at + 1_000) return current;
    state.pending = (async () => {
      if (current && !fresh && Date.parse(current.session.expiresAt) > at + 1_000) {
        try { return await renew(scopeId, current); }
        catch (error: unknown) {
          console.warn("[cli-collaboration] session renewal failed", error instanceof Error ? error.name : "UnknownError");
          // A new ticket and session is the bounded recovery path.
        }
      }
      return connect(scopeId, state.key);
    })().then((connected) => { state.connected = connected; return connected; })
      .catch((error: unknown) => { state.connected = null; throw error; })
      .finally(() => { state.pending = null; });
    return state.pending;
  };

  const signedRequest = async (connected: Connected, method: Method, path: string, query: string, body: string | undefined) => {
    const signature = {
      protocolVersion: COLLABORATION_DIRECT_PROTOCOL_VERSION, sessionId: connected.session.id,
      method, path, query, bodyDigest: digest(body ?? ""), conditionalHeadersDigest: digest(new Uint8Array()),
      nonce: randomBytes(32).toString("hex"), issuedAt: now().toISOString(),
    };
    const requestProof = proof(connected.key, `matrix-collaboration-request-v2\n${canonical(signature)}`);
    return fetchImpl(`${connected.origin}${path}${query ? `?${query}` : ""}`, {
      method, headers: {
        accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }),
        "x-matrix-collaboration-session": connected.session.id,
        "x-matrix-collaboration-request": b64json({ signature, proof: requestProof }),
      }, ...(body === undefined ? {} : { body }), redirect: "error",
      signal: AbortSignal.timeout(COLLABORATION_DIRECT_LIMITS.externalApiTimeoutMs),
    });
  };

  const request = async (scopeId: string, method: Method, rawPath: string, payload?: unknown): Promise<unknown> => {
    const url = new URL(rawPath, platform);
    if (!rawPath.startsWith("/api/collaboration/") || url.origin !== platform || url.hash
      || !(url.pathname.startsWith(`/api/collaboration/scopes/${scopeId}/`) || url.pathname === `/api/collaboration/scopes/${scopeId}`
        || /^\/api\/collaboration\/invitations\/[0-9a-f-]{36}(?:\/(?:accept|decline))?$/.test(url.pathname))) throw unavailable();
    const body = payload === undefined ? undefined : JSON.stringify(payload);
    if (body && Buffer.byteLength(body) > COLLABORATION_DIRECT_LIMITS.httpJsonBytes) throw unavailable();
    let connected = await ensure(scopeId);
    let response = await signedRequest(connected, method, url.pathname, url.search.slice(1), body);
    if (response.status === 401) {
      await response.body?.cancel();
      connected = await ensure(scopeId, true);
      response = await signedRequest(connected, method, url.pathname, url.search.slice(1), body);
    }
    if (response.status === 204) { await response.body?.cancel(); return null; }
    return boundedJson(response);
  };

  const terminal = async (scopeId: string): Promise<{ url: string; actorId: string; handshake: string }> => {
    const connected = await ensure(scopeId);
    const issued = await issueTicket(scopeId, "terminal", connected.key);
    if (issued.origin !== connected.origin) throw unavailable();
    const ticket = issued.signedTicket.ticket;
    const url = new URL(`/ws/collaboration/direct/scopes/${scopeId}/terminal`, issued.origin);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("ticket", b64json(issued.signedTicket));
    url.searchParams.set("after", "0");
    return {
      url: url.href, actorId: ticket.actorId,
      handshake: JSON.stringify({ protocolVersion: COLLABORATION_DIRECT_PROTOCOL_VERSION, type: "handshake",
        sessionId: connected.session.id, ticketNonce: ticket.nonce,
        possession: proof(connected.key, `matrix-collaboration-possession-v2\n${ticket.nonce}\nterminal\n${connected.session.id}`) }),
    };
  };

  return { request, terminal };
}

export type CliCollaborationTransport = ReturnType<typeof createCliCollaborationTransport>;
