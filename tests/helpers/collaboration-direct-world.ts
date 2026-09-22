/**
 * Fake platform + home for direct-client tests (S06). The platform signs
 * tickets with node crypto; the home verifies possession, request
 * signatures and stream handshakes exactly as the gateway does.
 */
import { randomUUID } from "node:crypto";
import { vi } from "vitest";
import { COLLABORATION_DIRECT_PROTOCOL_VERSION } from "@matrix-os/contracts";
import { ed25519PrivateKeyFromSeed, ed25519PublicKeyRaw, signEd25519, ticketSigningPayload } from "../../packages/platform/src/collaboration/ticket-crypto.js";
import { possessionPayload, proofKeyThumbprint, requestSigningPayload, sha256Hex, verifyEd25519 } from "../../packages/gateway/src/collaboration/direct-crypto.js";

export const PLATFORM = "https://app.matrix-os.com";
export const RELAY = "https://relay.matrix-os.com";
export const CLIENT_ORIGIN = "https://app.matrix-os.com";
export const scopeId = "10000000-0000-4000-8000-000000000101";
export const otherScopeId = "10000000-0000-4000-8000-000000000102";
export const actorId = "user_member";
export const organizationId = "org_direct_1";
export const runtimeId = "vps-11111111-1111-4111-8111-111111111111";
const platformKey = ed25519PrivateKeyFromSeed(Buffer.alloc(32, 7).toString("base64url"));

export type Json = Record<string, unknown>;

export interface HomeState {
  generation: number;
  sessions: Map<string, { publicKey: string; scopeId: string; expiresAt: string; renewAfter: string; generation: number }>;
  consumed: Set<string>;
  offline: boolean;
  protocolVersion: number;
  nextSessionTtlMs: number;
  requests: Array<{ method: string; url: string; headers: Headers; body: string }>;
  renewFails: boolean;
}

export function fakeDirectWorld() {
  const home: HomeState = {
    generation: 3, sessions: new Map(), consumed: new Set(), offline: false, protocolVersion: COLLABORATION_DIRECT_PROTOCOL_VERSION,
    nextSessionTtlMs: 300_000, requests: [], renewFails: false,
  };
  const platform = { tickets: [] as Json[], offlineScopes: new Set<string>(), inbox: [] as Json[], shared: [] as Json[] };
  let clock = Date.parse("2026-09-21T10:00:00.000Z");
  const now = () => new Date(clock);
  const advance = (ms: number) => { clock += ms; };
  const signTicket = (ticket: Json) => ({ ticket, keyId: "k1", signature: signEd25519(platformKey, ticketSigningPayload(ticket)) });
  const issue = (body: Json) => {
    const issuedAt = now();
    const ticket = {
      protocolVersion: home.protocolVersion, ticketId: randomUUID(), nonce: randomUUID().replaceAll("-", ""), actorId, organizationId,
      resource: { scopeId: body.scopeId, kind: "chat" }, purpose: body.purpose, runtime: { runtimeId, authorityGeneration: home.generation },
      proofKeyThumbprint: proofKeyThumbprint(body.proofPublicKey as string), maxActions: 1000,
      issuedAt: issuedAt.toISOString(), expiresAt: new Date(issuedAt.getTime() + 30_000).toISOString(),
    };
    platform.tickets.push(ticket);
    return { signedTicket: signTicket(ticket), endpoint: { origin: RELAY, protocolVersion: home.protocolVersion } };
  };
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
  const sessionFor = (ticket: Json, publicKey: string, previous?: string) => {
    const id = previous ?? randomUUID();
    const issuedAt = now();
    const expiresAt = new Date(issuedAt.getTime() + home.nextSessionTtlMs).toISOString();
    const renewAfter = new Date(issuedAt.getTime() + home.nextSessionTtlMs - 60_000).toISOString();
    const session = {
      protocolVersion: COLLABORATION_DIRECT_PROTOCOL_VERSION, id, actorId, organizationId, scopeId: (ticket.resource as Json).scopeId as string, runtimeId,
      authorityGeneration: (ticket.runtime as Json).authorityGeneration as number, purpose: "direct_session", proofKeyThumbprint: ticket.proofKeyThumbprint,
      issuedAt: issuedAt.toISOString(), expiresAt, evidenceExpiresAt: new Date(issuedAt.getTime() + 20_000).toISOString(), renewAfter,
    };
    home.sessions.set(id, { publicKey, scopeId: session.scopeId, expiresAt, renewAfter, generation: session.authorityGeneration });
    return session;
  };
  const verifyTicket = (signed: Json): Json | null => {
    const ticket = signed.ticket as Json;
    if (!verifyEd25519(ed25519PublicKeyRaw(platformKey), ticketSigningPayload(ticket), signed.signature as string)) return null;
    if (home.consumed.has(ticket.nonce as string)) return null;
    if (Date.parse(ticket.expiresAt as string) <= clock) return null;
    return ticket;
  };
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === "string" ? init.body : "";
    if (url.origin === PLATFORM) {
      if (url.pathname === "/api/collaboration/connections" && method === "POST") {
        const parsed = JSON.parse(body) as Json;
        if (platform.offlineScopes.has(parsed.scopeId as string)) return json({ error: "Collaboration unavailable" }, 503);
        return json(issue(parsed), 201);
      }
      if (url.pathname === "/api/collaboration/inbox") return json({ items: platform.inbox });
      if (url.pathname === "/api/collaboration/shared") return json({ items: platform.shared });
      return json({ error: "not found" }, 404);
    }
    if (url.origin !== RELAY) return json({ error: "wrong origin" }, 404);
    home.requests.push({ method, url: url.href, headers, body });
    if (home.offline) return json({ error: "Collaboration unavailable" }, 503);
    if (url.pathname === "/api/collaboration/direct-sessions" && method === "POST") {
      const parsed = JSON.parse(body) as Json;
      if (((parsed.signedTicket as Json).ticket as Json).protocolVersion !== COLLABORATION_DIRECT_PROTOCOL_VERSION) return json({ error: "upgrade_required" }, 426);
      const ticket = verifyTicket(parsed.signedTicket as Json);
      if (!ticket || url.searchParams.get("scope") !== (ticket.resource as Json).scopeId) return json({ error: "Collaboration request denied" }, 401);
      if (parsed.clientOrigin !== CLIENT_ORIGIN) return json({ error: "Collaboration request denied" }, 401);
      if (proofKeyThumbprint(parsed.proofPublicKey as string) !== ticket.proofKeyThumbprint) return json({ error: "denied" }, 401);
      if (!verifyEd25519(parsed.proofPublicKey as string, possessionPayload({ ticketNonce: ticket.nonce as string, purpose: "direct_session" }), parsed.possession as string)) return json({ error: "denied" }, 401);
      home.consumed.add(ticket.nonce as string);
      return json(sessionFor(ticket, parsed.proofPublicKey as string), 201);
    }
    const renew = /^\/api\/collaboration\/direct-sessions\/([^/]+)\/renew$/.exec(url.pathname);
    if (renew && method === "POST") {
      if (home.renewFails) return json({ error: "Collaboration unavailable" }, 503);
      const record = home.sessions.get(renew[1]!);
      const parsed = JSON.parse(body) as Json;
      const ticket = verifyTicket(parsed.signedTicket as Json);
      if (!record || !ticket) return json({ error: "denied" }, 401);
      home.consumed.add(ticket.nonce as string);
      return json(sessionFor(ticket, record.publicKey, renew[1]!));
    }
    // Signed scope request.
    const sessionId = headers.get("x-matrix-collaboration-session");
    const encoded = headers.get("x-matrix-collaboration-request");
    const record = sessionId ? home.sessions.get(sessionId) : undefined;
    if (!record || !encoded) return json({ error: "Collaboration request denied" }, 401);
    if (Date.parse(record.expiresAt) <= clock) { home.sessions.delete(sessionId!); return json({ error: "Collaboration request denied" }, 401); }
    const envelope = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as { signature: Json; proof: string };
    const signature = envelope.signature;
    const ok = signature.sessionId === sessionId && signature.method === method && signature.path === url.pathname
      && signature.query === url.search.slice(1) && signature.bodyDigest === sha256Hex(new TextEncoder().encode(body))
      && Math.abs(Date.parse(signature.issuedAt as string) - clock) <= 35_000
      && verifyEd25519(record.publicKey, requestSigningPayload(signature), envelope.proof);
    if (!ok) return json({ error: "Collaboration request denied" }, 401);
    if (record.generation !== home.generation) { home.sessions.delete(sessionId!); return json({ error: "Collaboration request denied" }, 401); }
    if (url.pathname === `/api/collaboration/scopes/${record.scopeId}/chat`) return json({ id: "chat-1", scopeId: record.scopeId, title: "Design review" });
    if (url.pathname === `/api/collaboration/scopes/${record.scopeId}`) return json({ id: record.scopeId, kind: "chat", role: "editor" });
    if (url.pathname.endsWith("/chat/messages") && method === "POST") return json({ accepted: true, echo: JSON.parse(body) });
    if (url.pathname.startsWith("/api/collaboration/invitations/")) return json({ id: url.pathname.split("/")[4], revision: "4", role: "editor", owner: { displayName: "Owner" } });
    return json({ error: "not found" }, 404);
  });
  const sockets: Array<{ url: string; sent: string[]; onopen: (() => void) | null; onmessage: ((event: { data: string }) => void) | null; onclose: (() => void) | null; onerror: (() => void) | null; close: ReturnType<typeof vi.fn>; send: (value: string) => void }> = [];
  const webSocketFactory = (url: string) => {
    const socket = {
      url, sent: [] as string[], onopen: null, onmessage: null, onclose: null, onerror: null,
      close: vi.fn(), send: (value: string) => { socket.sent.push(value); },
    };
    sockets.push(socket as never);
    return socket as unknown as WebSocket;
  };
  return { home, platform, fetchImpl, webSocketFactory, sockets, now, advance, verifyTicket };
}

