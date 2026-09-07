import { randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import {
  CollaborationConnectionTicketRequestSchema,
  CollaborationConnectionTicketResponseSchema,
} from "@matrix-os/contracts";
import type { CollaborationProofSigner } from "./proof.js";
import {
  PlatformCollaborationRepositoryError,
  type PlatformCollaborationRepository,
} from "./repository.js";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const COLLABORATION_SOCKET_PATH = new RegExp(
  `^/ws/collaboration/scopes/(${UUID})/(events|terminal)$`,
);
const TICKET_LIFETIME_MS = 30_000;
const MAX_RAW_PATH_LENGTH = 1_024;
const MAX_ALLOWED_ORIGINS = 16;
const FORWARDED_SOCKET_HEADERS = new Set([
  "connection",
  "upgrade",
  "sec-websocket-key",
  "sec-websocket-version",
  "sec-websocket-protocol",
  "sec-websocket-extensions",
]);

type SignedProof = ReturnType<CollaborationProofSigner["signSocket"]>;
type Purpose = "events" | "terminal";

export type CollaborationWebSocketErrorCode =
  | "invalid_route"
  | "invalid_origin"
  | "invalid_ticket"
  | "disabled"
  | "unavailable";

export class CollaborationWebSocketError extends Error {
  constructor(public readonly code: CollaborationWebSocketErrorCode, message: string) {
    super(message);
    this.name = "CollaborationWebSocketError";
  }
}

export interface CollaborationWebSocketUpgrade {
  upstreamPath: string;
  runtimeId: string;
  ownerId: string;
  scopeId: string;
  purpose: Purpose;
  signedProof: SignedProof;
}

export function isCollaborationWebSocketPath(rawPath: string): boolean {
  if (rawPath.length > MAX_RAW_PATH_LENGTH || /[\r\n]/.test(rawPath)) return false;
  try {
    return COLLABORATION_SOCKET_PATH.test(new URL(rawPath, "https://platform.invalid").pathname);
  } catch (error: unknown) {
    if (!(error instanceof TypeError)) {
      console.warn("[collaboration-websocket] path classification failed", error instanceof Error ? error.name : "UnknownError");
    }
    return false;
  }
}

export function isCollaborationWebSocketCandidate(rawPath: string): boolean {
  if (rawPath.length > MAX_RAW_PATH_LENGTH || /[\r\n]/.test(rawPath)) return false;
  try {
    return new URL(rawPath, "https://platform.invalid").pathname.startsWith("/ws/collaboration/");
  } catch (error: unknown) {
    if (!(error instanceof TypeError)) {
      console.warn("[collaboration-websocket] candidate classification failed", error instanceof Error ? error.name : "UnknownError");
    }
    return false;
  }
}

export function buildCollaborationWebSocketUpgradeHeaders(input: {
  incomingHeaders: IncomingMessage["headers"];
  externalHost: string;
  signedProof: unknown;
}): string {
  const headers = Object.entries(input.incomingHeaders).flatMap(([name, raw]) => {
    if (!FORWARDED_SOCKET_HEADERS.has(name) || raw === undefined) return [];
    const value = Array.isArray(raw) ? raw.join(", ") : raw;
    if (value.length > 8_192 || /[\r\n]/.test(value)) return [];
    return `${name}: ${value}`;
  });
  headers.push(`x-forwarded-host: ${input.externalHost}`);
  headers.push("x-forwarded-proto: https");
  headers.push(`x-matrix-collaboration-proof: ${Buffer.from(JSON.stringify(input.signedProof)).toString("base64url")}`);
  return headers.join("\r\n");
}

export class CollaborationWebSocketAuthorizer {
  private readonly now: () => Date;
  private readonly createToken: () => string;
  private readonly allowedOrigins: readonly string[];
  private readonly enabledPurposes: readonly Purpose[];

  constructor(private readonly options: {
    repository: PlatformCollaborationRepository;
    signer: CollaborationProofSigner;
    allowedOrigins: readonly string[];
    enabledPurposes: readonly Purpose[];
    now?: () => Date;
    createToken?: () => string;
  }) {
    if (options.allowedOrigins.length < 1 || options.allowedOrigins.length > MAX_ALLOWED_ORIGINS) {
      throw new Error("Collaboration WebSocket origin allowlist is invalid");
    }
    this.allowedOrigins = options.allowedOrigins.map(requireOrigin);
    this.enabledPurposes = [...new Set(options.enabledPurposes)];
    if (this.enabledPurposes.length < 1 || this.enabledPurposes.length > 2) {
      throw new Error("Collaboration WebSocket purpose configuration is invalid");
    }
    this.now = options.now ?? (() => new Date());
    this.createToken = options.createToken ?? (() => randomBytes(32).toString("base64url"));
  }

  async issueTicket(input: {
    actorId: string;
    scopeId: string;
    purpose: Purpose;
    clientRequestId: string;
  }): Promise<{ ticket: string; expiresAt: string }> {
    const request = CollaborationConnectionTicketRequestSchema.parse({
      purpose: input.purpose,
      clientRequestId: input.clientRequestId,
    });
    this.assertPurposeEnabled(request.purpose);
    const directory = await this.requireAcceptedDirectory(input.scopeId, input.actorId, request.purpose);
    const policy = await this.requirePolicy(input.actorId, directory.ownerId, input.scopeId, request.purpose);
    const ticket = this.createToken();
    const expiresAt = new Date(this.now().getTime() + TICKET_LIFETIME_MS).toISOString();
    const response = CollaborationConnectionTicketResponseSchema.parse({ ticket, expiresAt });
    await this.options.repository.createConnectionTicket({
      token: response.ticket,
      actorId: input.actorId,
      scopeId: input.scopeId,
      purpose: request.purpose,
      policyRevision: Number(policy.revision),
      expiresAt: response.expiresAt,
    });
    return response;
  }

  async authorizeUpgrade(input: {
    actorId: string;
    authentication: "session" | "bearer" | "ticket";
    rawPath: string;
    origin?: string;
  }): Promise<CollaborationWebSocketUpgrade> {
    this.requireOrigin(input.origin, input.authentication);
    const route = parseRoute(input.rawPath);
    this.assertPurposeEnabled(route.purpose);
    const directory = await this.requireAcceptedDirectory(route.scopeId, input.actorId, route.purpose);
    const policy = await this.requirePolicy(input.actorId, directory.ownerId, route.scopeId, route.purpose);
    if (input.authentication === "ticket") {
      if (!route.ticket) throw new CollaborationWebSocketError("invalid_ticket", "Connection ticket is invalid");
      try {
        const consumed = await this.options.repository.consumeConnectionTicket({
          token: route.ticket,
          actorId: input.actorId,
          scopeId: route.scopeId,
          purpose: route.purpose,
        });
        if (consumed.policyRevision !== Number(policy.revision)) {
          throw new CollaborationWebSocketError("invalid_ticket", "Connection ticket is stale");
        }
      } catch (error: unknown) {
        if (error instanceof CollaborationWebSocketError) throw error;
        if (error instanceof PlatformCollaborationRepositoryError && error.code === "invalid_ticket") {
          throw new CollaborationWebSocketError("invalid_ticket", "Connection ticket is invalid");
        }
        throw error;
      }
    } else if (route.ticket) {
      throw new CollaborationWebSocketError("invalid_route", "Unexpected connection credential");
    }
    const signedProof = this.options.signer.signSocket({
      actorId: input.actorId,
      ownerId: directory.ownerId,
      runtimeId: directory.runtimeId,
      scopeId: route.scopeId,
      purpose: route.purpose,
      path: route.path,
      query: route.query,
    });
    return {
      upstreamPath: `${route.path}${route.query ? `?${route.query}` : ""}`,
      runtimeId: directory.runtimeId,
      ownerId: directory.ownerId,
      scopeId: route.scopeId,
      purpose: route.purpose,
      signedProof,
    };
  }

  private assertPurposeEnabled(purpose: Purpose): void {
    if (!this.enabledPurposes.includes(purpose)) {
      throw new CollaborationWebSocketError("disabled", "Collaboration socket is unavailable");
    }
  }

  private requireOrigin(origin: string | undefined, authentication: "session" | "bearer" | "ticket"): void {
    if (!origin && authentication === "bearer") return;
    if (!origin || !this.allowedOrigins.includes(origin)) {
      throw new CollaborationWebSocketError("invalid_origin", "Collaboration socket origin is invalid");
    }
  }

  private async requireAcceptedDirectory(scopeId: string, actorId: string, purpose: Purpose) {
    const [directory, status] = await Promise.all([
      this.options.repository.getDirectoryRoute(scopeId),
      this.options.repository.getScopeActorStatus(scopeId, actorId),
    ]);
    if (!directory || status !== "accepted") {
      throw new CollaborationWebSocketError("unavailable", "Collaboration scope is unavailable");
    }
    if (purpose === "terminal" && directory.kind !== "terminal") {
      throw new CollaborationWebSocketError("unavailable", "Collaboration scope is unavailable");
    }
    return directory;
  }

  private async requirePolicy(actorId: string, ownerId: string, scopeId: string, purpose: Purpose) {
    const policy = await this.options.repository.getPolicy(purpose === "terminal" ? "m3" : "m1");
    const participants = await this.options.repository.listScopeActors(scopeId);
    if (!policyAllows(policy, actorId, ownerId, participants)) {
      throw new CollaborationWebSocketError("disabled", "Collaboration socket is unavailable");
    }
    return policy;
  }
}

function parseRoute(rawPath: string): {
  path: string;
  query: string;
  scopeId: string;
  purpose: Purpose;
  ticket?: string;
} {
  if (rawPath.length > MAX_RAW_PATH_LENGTH || /[\r\n]/.test(rawPath)) {
    throw new CollaborationWebSocketError("invalid_route", "Collaboration socket route is invalid");
  }
  let parsed: URL;
  try {
    parsed = new URL(rawPath, "https://platform.invalid");
  } catch (error: unknown) {
    if (!(error instanceof TypeError)) {
      console.warn("[collaboration-websocket] route parse failed", error instanceof Error ? error.name : "UnknownError");
    }
    throw new CollaborationWebSocketError("invalid_route", "Collaboration socket route is invalid");
  }
  const match = COLLABORATION_SOCKET_PATH.exec(parsed.pathname);
  const keys = [...parsed.searchParams.keys()];
  const ticket = parsed.searchParams.get("ticket") ?? undefined;
  const after = parsed.searchParams.get("after") ?? undefined;
  if (!match || keys.some((key) => !["ticket", "after"].includes(key))
    || keys.filter((key) => key === "ticket").length > 1
    || keys.filter((key) => key === "after").length > 1
    || (ticket !== undefined && (ticket.length < 43 || ticket.length > 256 || !/^[A-Za-z0-9_-]+$/.test(ticket)))) {
    throw new CollaborationWebSocketError("invalid_route", "Collaboration socket route is invalid");
  }
  const purpose = match[2] as Purpose;
  if (after !== undefined && (purpose !== "events" || !/^(?:0|[1-9][0-9]{0,18})$/.test(after))) {
    throw new CollaborationWebSocketError("invalid_route", "Collaboration socket route is invalid");
  }
  return {
    path: parsed.pathname,
    query: after === undefined ? "" : `after=${after}`,
    scopeId: match[1]!,
    purpose,
    ...(ticket ? { ticket } : {}),
  };
}

function requireOrigin(value: string): string {
  try {
    const parsed = new URL(value);
    if (!parsed.hostname || !["https:", "http:"].includes(parsed.protocol)
      || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash
      || parsed.origin !== value) throw new Error("invalid origin");
    return parsed.origin;
  } catch (error: unknown) {
    if (!(error instanceof TypeError || error instanceof Error)) {
      console.warn("[collaboration-websocket] origin parse failed", "UnknownError");
    }
    throw new Error("Collaboration WebSocket origin allowlist is invalid");
  }
}

function policyAllows(
  policy: { mode: "off" | "internal" | "enabled" | "read_only"; cohort: string[] },
  actorId: string,
  ownerId: string,
  participants: string[],
): boolean {
  if (policy.mode === "off") return false;
  if (policy.mode === "enabled" || policy.mode === "read_only") return true;
  const cohort = new Set(policy.cohort);
  return cohort.has(actorId) && cohort.has(ownerId) && participants.every((actor) => cohort.has(actor));
}
