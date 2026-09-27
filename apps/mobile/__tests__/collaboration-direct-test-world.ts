/**
 * Fake platform + scope home for the Native Mobile direct transport tests.
 *
 * The platform half answers exactly what `packages/platform` serves after the
 * direct cutover: tickets at `POST /api/collaboration/connections`, metadata-only
 * discovery, a 404 for the retired V1 connection-ticket route, and a relay that
 * forwards only session routes or requests carrying a direct session (the same
 * `parseRelayRoute` predicate the platform uses). The home half verifies tickets,
 * possession proofs and request signatures with the gateway's own crypto helpers.
 */
import { randomUUID } from "node:crypto";

// The platform relay imports the contracts root, which pulls ESM-only markdown
// dependencies jest does not transform; the relay only needs these two modules.
jest.mock("@matrix-os/contracts", () => ({
  ...jest.requireActual("@matrix-os/contracts/collaboration"),
  ...jest.requireActual("@matrix-os/contracts/collaboration-direct"),
}));
import { COLLABORATION_DIRECT_PROTOCOL_VERSION } from "@matrix-os/contracts/collaboration-direct";
import {
  ed25519PrivateKeyFromSeed,
  ed25519PublicKeyRaw,
  signEd25519,
  ticketSigningPayload,
} from "../../../packages/platform/src/collaboration/ticket-crypto";
import {
  possessionPayload,
  proofKeyThumbprint,
  requestSigningPayload,
  sha256Hex,
  verifyEd25519,
} from "../../../packages/gateway/src/collaboration/direct-crypto";

/**
 * The platform's own relay predicates, loaded without type-checking because the
 * relay module is compiled against Node timers rather than the React Native lib
 * the mobile tsconfig uses. Tests fail at runtime if these signatures drift.
 */
export const relay = jest.requireActual("../../../packages/platform/src/collaboration/relay") as {
  parseRelayRoute(method: string, path: string): { kind: "session" | "scope" | "invitation" | "runtime"; identifier?: string } | null;
  parseRelaySocketPath(rawPath: string): { scopeId: string; purpose: "events" | "terminal"; path: string; query: string } | null;
  isCollaborationWebSocketCandidate(rawPath: string): boolean;
};

export const PLATFORM = "https://app.matrix-os.com";
export const SEPARATE_RELAY = "https://relay.matrix-os.com";
export const scopeId = "10000000-0000-4000-8000-000000000101";
export const otherScopeId = "10000000-0000-4000-8000-000000000102";
export const invitationId = "30000000-0000-4000-8000-000000000101";
export const actorId = "user_member";
export const organizationId = "org_direct_1";
export const runtimeId = "vps-11111111-1111-4111-8111-111111111111";

const RETIRED_CONNECTION_TICKET_PATH = /^\/api\/collaboration\/scopes\/[^/]+\/connection-tickets$/;
const platformKey = ed25519PrivateKeyFromSeed(Buffer.alloc(32, 7).toString("base64url"));

type Json = Record<string, unknown>;

export interface RecordedRequest {
  origin: string;
  method: string;
  path: string;
  query: string;
  headers: Headers;
  body: string;
}

export interface HomeSession {
  id: string;
  publicKey: string;
  scopeId: string;
  actorId: string;
  expiresAt: string;
  renewAfter: string;
  generation: number;
}

/** A JWT-shaped bearer; the platform half reads its subject the way Clerk verification would. */
export function actorToken(subject = actorId): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ sub: subject, sid: "sess_test" })}.${"s".repeat(43)}`;
}

function tokenSubject(authorization: string | null): string | null {
  if (!authorization?.startsWith("Bearer ")) return null;
  const payload = authorization.slice("Bearer ".length).split(".")[1];
  if (!payload) return null;
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { sub?: unknown };
  return typeof claims.sub === "string" ? claims.sub : null;
}

export function createDirectTestWorld(options: { relayOrigin?: string; startAt?: number } = {}) {
  const relayOrigin = options.relayOrigin ?? PLATFORM;
  const home = {
    generation: 3,
    sessions: new Map<string, HomeSession>(),
    consumed: new Set<string>(),
    protocolVersion: COLLABORATION_DIRECT_PROTOCOL_VERSION as number,
    sessionTtlMs: 300_000,
    renewFails: false,
    /** Canned responses keyed by `${method} ${path}`; anything else is a 404 from the home. */
    responses: new Map<string, { status: number; body?: unknown }>(),
    /** Signed requests the home accepted, with the session that authorized them. */
    accepted: [] as Array<{ method: string; path: string; query: string; body: string; session: HomeSession; conditionalHeadersDigest: string }>,
  };
  const platform = {
    tickets: [] as Json[],
    offlineScopes: new Set<string>(),
    scopeKinds: new Map<string, string>(),
    /** Overrides the actor a ticket is issued to, to prove the client refuses a foreign ticket. */
    ticketActorOverride: null as string | null,
    inbox: [] as Json[],
    shared: [] as Json[],
  };
  const requests: RecordedRequest[] = [];
  let clock = options.startAt ?? Date.parse("2026-09-21T10:00:00.000Z");
  const now = () => new Date(clock);
  const advance = (ms: number) => { clock += ms; };

  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });

  const issue = (subject: string, body: Json) => {
    const issuedAt = now();
    const ticket = {
      protocolVersion: home.protocolVersion,
      ticketId: randomUUID(),
      nonce: randomUUID().replaceAll("-", ""),
      actorId: platform.ticketActorOverride ?? subject,
      organizationId,
      resource: { scopeId: body.scopeId, kind: platform.scopeKinds.get(body.scopeId as string) ?? "chat" },
      purpose: body.purpose,
      runtime: { runtimeId, authorityGeneration: home.generation },
      proofKeyThumbprint: proofKeyThumbprint(body.proofPublicKey as string),
      maxActions: 1000,
      issuedAt: issuedAt.toISOString(),
      expiresAt: new Date(issuedAt.getTime() + 30_000).toISOString(),
    };
    platform.tickets.push(ticket);
    return {
      signedTicket: { ticket, keyId: "k1", signature: signEd25519(platformKey, ticketSigningPayload(ticket)) },
      endpoint: { origin: relayOrigin, protocolVersion: home.protocolVersion },
    };
  };

  /** Mirrors the home's ticket checks: platform signature, single use, lifetime. */
  const verifyTicket = (signed: Json): Json | null => {
    const ticket = signed.ticket as Json;
    if (!verifyEd25519(ed25519PublicKeyRaw(platformKey), ticketSigningPayload(ticket), signed.signature as string)) return null;
    if (home.consumed.has(ticket.nonce as string)) return null;
    if (Date.parse(ticket.expiresAt as string) <= clock) return null;
    return ticket;
  };

  const openSession = (ticket: Json, publicKey: string, previous?: string) => {
    const id = previous ?? randomUUID();
    const issuedAt = now();
    const expiresAt = new Date(issuedAt.getTime() + home.sessionTtlMs).toISOString();
    const renewAfter = new Date(issuedAt.getTime() + home.sessionTtlMs - 60_000).toISOString();
    const scope = (ticket.resource as Json).scopeId as string;
    const record = {
      id, publicKey, scopeId: scope, actorId: ticket.actorId as string, expiresAt, renewAfter,
      generation: (ticket.runtime as Json).authorityGeneration as number,
    };
    home.sessions.set(id, record);
    return {
      protocolVersion: COLLABORATION_DIRECT_PROTOCOL_VERSION, id, actorId: record.actorId, organizationId, scopeId: scope, runtimeId,
      authorityGeneration: record.generation, purpose: "direct_session", proofKeyThumbprint: ticket.proofKeyThumbprint,
      issuedAt: issuedAt.toISOString(), expiresAt,
      evidenceExpiresAt: new Date(issuedAt.getTime() + 20_000).toISOString(), renewAfter,
    };
  };

  const serveHome = (method: string, url: URL, headers: Headers, body: string): Response => {
    if (url.pathname === "/api/collaboration/direct-sessions" && method === "POST") {
      const parsed = JSON.parse(body) as Json;
      const signed = parsed.signedTicket as Json;
      if ((signed.ticket as Json).protocolVersion !== COLLABORATION_DIRECT_PROTOCOL_VERSION) return json({ error: "upgrade_required" }, 426);
      const ticket = verifyTicket(signed);
      if (!ticket || ticket.purpose !== "direct_session" || url.searchParams.get("scope") !== (ticket.resource as Json).scopeId) {
        return json({ error: "Collaboration request denied" }, 401);
      }
      if (headers.get("x-matrix-collaboration-runtime") !== (ticket.runtime as Json).runtimeId) return json({ error: "denied" }, 401);
      if (parsed.clientOrigin !== PLATFORM) return json({ error: "denied" }, 401);
      if (proofKeyThumbprint(parsed.proofPublicKey as string) !== ticket.proofKeyThumbprint) return json({ error: "denied" }, 401);
      if (!verifyEd25519(parsed.proofPublicKey as string, possessionPayload({ ticketNonce: ticket.nonce as string, purpose: "direct_session" }), parsed.possession as string)) {
        return json({ error: "denied" }, 401);
      }
      home.consumed.add(ticket.nonce as string);
      return json(openSession(ticket, parsed.proofPublicKey as string), 201);
    }
    const renew = /^\/api\/collaboration\/direct-sessions\/([^/]+)\/renew$/.exec(url.pathname);
    if (renew && method === "POST") {
      if (home.renewFails) return json({ error: "Collaboration unavailable" }, 503);
      const record = home.sessions.get(renew[1]!);
      const ticket = verifyTicket((JSON.parse(body) as Json).signedTicket as Json);
      if (!record || !ticket || proofKeyThumbprint(record.publicKey) !== ticket.proofKeyThumbprint) return json({ error: "denied" }, 401);
      home.consumed.add(ticket.nonce as string);
      return json(openSession(ticket, record.publicKey, record.id));
    }
    const sessionId = headers.get("x-matrix-collaboration-session");
    const encoded = headers.get("x-matrix-collaboration-request");
    const record = sessionId ? home.sessions.get(sessionId) : undefined;
    if (!record || !encoded) return json({ error: "Collaboration request denied" }, 401);
    if (Date.parse(record.expiresAt) <= clock || record.generation !== home.generation) {
      home.sessions.delete(record.id);
      return json({ error: "Collaboration request denied" }, 401);
    }
    const envelope = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as { signature: Json; proof: string };
    const signature = envelope.signature;
    const verified = signature.protocolVersion === COLLABORATION_DIRECT_PROTOCOL_VERSION
      && signature.sessionId === record.id && signature.method === method && signature.path === url.pathname
      && signature.query === url.search.slice(1) && signature.bodyDigest === sha256Hex(new TextEncoder().encode(body))
      && Math.abs(Date.parse(signature.issuedAt as string) - clock) <= 35_000
      && verifyEd25519(record.publicKey, requestSigningPayload(signature), envelope.proof);
    if (!verified) return json({ error: "Collaboration request denied" }, 401);
    const scoped = url.pathname === `/api/collaboration/scopes/${record.scopeId}` || url.pathname.startsWith(`/api/collaboration/scopes/${record.scopeId}/`);
    if (!scoped && !url.pathname.startsWith("/api/collaboration/invitations/")) return json({ error: "Collaboration request denied" }, 403);
    home.accepted.push({
      method, path: url.pathname, query: url.search.slice(1), body, session: record,
      conditionalHeadersDigest: signature.conditionalHeadersDigest as string,
    });
    const canned = home.responses.get(`${method} ${url.pathname}`);
    if (!canned) return json({ error: "Collaboration resource not found" }, 404);
    if (canned.status === 204) return new Response(null, { status: 204 });
    return json(canned.body, canned.status);
  };

  const fetchImpl = jest.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === "string" ? init.body : "";
    requests.push({ origin: url.origin, method, path: url.pathname, query: url.search.slice(1), headers, body });
    if (url.origin === PLATFORM && url.pathname.startsWith("/api/collaboration/")) {
      // Platform-served routes first, in the order `collaboration/routes.ts` applies them.
      if (method === "POST" && RETIRED_CONNECTION_TICKET_PATH.test(url.pathname)) return json({ error: "Collaboration route not found" }, 404);
      const subject = tokenSubject(headers.get("authorization"));
      if (url.pathname === "/api/collaboration/connections" && method === "POST") {
        if (!subject) return json({ error: "Unauthorized" }, 401);
        const parsed = JSON.parse(body) as Json;
        if (platform.offlineScopes.has(parsed.scopeId as string)) return json({ error: "host_offline" }, 503);
        return json(issue(subject, parsed), 201);
      }
      if (url.pathname === "/api/collaboration/inbox" && method === "GET") return subject ? json({ items: platform.inbox }) : json({ error: "Unauthorized" }, 401);
      if (url.pathname === "/api/collaboration/shared" && method === "GET") return subject ? json({ items: platform.shared }) : json({ error: "Unauthorized" }, 401);
    }
    if (url.origin !== relayOrigin) return json({ error: "Collaboration route not found" }, 404);
    const route = relay.parseRelayRoute(method, url.pathname);
    if (!route || (route.kind !== "session" && !headers.get("x-matrix-collaboration-session"))) {
      // Unsigned legacy content is not relayed; on the platform it falls through to personal routing.
      return json({ error: "Collaboration route not found" }, 404);
    }
    if (relayOrigin === PLATFORM && !tokenSubject(headers.get("authorization"))) return json({ error: "Unauthorized" }, 401);
    return serveHome(method, url, headers, body);
  });

  return { home, platform, requests, fetchImpl, now, advance, verifyTicket, relayOrigin, platformPublicKey: ed25519PublicKeyRaw(platformKey) };
}

export type DirectTestWorld = ReturnType<typeof createDirectTestWorld>;
