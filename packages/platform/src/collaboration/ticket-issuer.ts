/**
 * Connection ticket issuer (S05 / T026).
 *
 * The platform authenticates the actor, checks fresh organization membership
 * through the projection and the actor's directory relationship to the
 * resource, then signs a short-lived ticket bound to the actor, nonce,
 * proof-key thumbprint, resource, purpose, logical runtime id and authority
 * generation. Tickets carry no hostname: the client dials the origin the
 * directory returns, which in this release is the platform relay. Nothing
 * here authorizes a request; the home verifies the ticket and its own policy.
 */
import { randomBytes, randomUUID, type KeyObject } from "node:crypto";
import {
  COLLABORATION_DIRECT_LIMITS,
  COLLABORATION_DIRECT_PROTOCOL_VERSION,
  CollaborationIdSchema,
  CollaborationOwnerRuntimeConnectionRequestSchema,
  CollaborationSignedConnectionTicketSchema,
  CollaborationSignedOwnerRuntimeTicketSchema,
  CollaborationTicketPurposeSchema,
  type CollaborationRuntimePublicKeySchema,
  type CollaborationSignedConnectionTicket,
  type CollaborationSignedOwnerRuntimeTicket,
} from "@matrix-os/contracts";
import { z } from "zod/v4";
import type { PlatformCollaborationRepository } from "./repository.js";
import type { CollaborationRuntimeEndpointRegistry } from "./runtime-endpoints.js";
import {
  ed25519PrivateKeyFromSeed,
  ed25519PublicKeyRaw,
  proofKeyThumbprint,
  signEd25519,
  ticketSigningPayload,
} from "./ticket-crypto.js";

const BASE64URL_KEY = /^[A-Za-z0-9_-]{43}$/;
const KEY_ID = /^[A-Za-z0-9_.-]{1,80}$/;
const MAX_KEYS = 8;

/** Request body for `POST /api/collaboration/connections` (route table row; schema owned here until S02 exports it). */
export const CollaborationConnectionRequestSchema = z.object({
  clientRequestId: CollaborationIdSchema,
  scopeId: CollaborationIdSchema,
  purpose: CollaborationTicketPurposeSchema.exclude(["control", "peer"]),
  proofPublicKey: z.string().regex(BASE64URL_KEY),
  maxActions: z.number().int().min(1).max(COLLABORATION_DIRECT_LIMITS.maxTicketActions).optional(),
}).strict();
export type CollaborationConnectionRequest = z.infer<typeof CollaborationConnectionRequestSchema>;

export interface TicketSigningKeyring {
  activeKeyId: string;
  /** keyId → base64url 32-byte Ed25519 seed. */
  keys: Readonly<Record<string, string>>;
  /** Keys still published for verification during rotation overlap; never used to sign. */
  retired?: Readonly<Record<string, string>>;
}

export type CollaborationTicketIssuerErrorCode = "invalid_request" | "not_found" | "unavailable" | "host_offline" | "configuration";

/** A home counts as reachable when its control stream attached or acknowledged within this window. */
export const HOME_LIVENESS_WINDOW_MS = 60_000;

export class CollaborationTicketIssuerError extends Error {
  constructor(public readonly code: CollaborationTicketIssuerErrorCode, message: string) {
    super(message);
    this.name = "CollaborationTicketIssuerError";
  }
}

export interface IssuedConnectionTicket {
  signedTicket: CollaborationSignedConnectionTicket;
  endpoint: { origin: string; protocolVersion: typeof COLLABORATION_DIRECT_PROTOCOL_VERSION };
}

export interface IssuedOwnerRuntimeTicket {
  signedTicket: CollaborationSignedOwnerRuntimeTicket;
  endpoint: { origin: string; protocolVersion: typeof COLLABORATION_DIRECT_PROTOCOL_VERSION };
}

export function loadTicketSigningKeyring(env: NodeJS.ProcessEnv): TicketSigningKeyring | null {
  const activeKeyId = env.MATRIX_COLLABORATION_TICKET_ACTIVE_KEY_ID?.trim();
  const keys = parseKeyMap(env.MATRIX_COLLABORATION_TICKET_KEYS);
  const retired = parseKeyMap(env.MATRIX_COLLABORATION_TICKET_RETIRED_KEYS ?? "{}");
  if (!activeKeyId || !keys || !retired || !keys[activeKeyId]) return null;
  return { activeKeyId, keys, retired };
}

function parseKeyMap(raw: string | undefined): Record<string, string> | null {
  if (raw === undefined) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const entries = Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string");
    if (entries.length > MAX_KEYS || entries.some(([keyId, seed]) => !KEY_ID.test(keyId) || Buffer.from(seed, "base64url").byteLength !== 32)) return null;
    return Object.fromEntries(entries);
  } catch (error: unknown) {
    if (!(error instanceof SyntaxError)) console.warn("[collaboration-tickets] key configuration parse failed", error instanceof Error ? error.name : "UnknownError");
    return null;
  }
}

export class CollaborationTicketIssuer {
  private readonly signingKeys = new Map<string, KeyObject>();
  private readonly published: Array<z.infer<typeof CollaborationRuntimePublicKeySchema>> = [];
  private readonly now: () => Date;
  private readonly createId: () => string;
  private readonly createNonce: () => string;

  constructor(private readonly options: {
    keyring: TicketSigningKeyring;
    repository: Pick<PlatformCollaborationRepository, "getDirectoryRoute" | "getScopeActorStatus">;
    endpoints: Pick<CollaborationRuntimeEndpointRegistry, "resolveEnrolled">;
    /** Resolves the owning organization of a shared scope; null denies. */
    resolveOrganization(scopeId: string): Promise<string | null>;
    projection: { isCurrentMember(input: { organizationId: string; actorId: string }): Promise<boolean> };
    relayOrigin: string;
    now?: () => Date;
    createId?: () => string;
    createNonce?: () => string;
  }) {
    const { keyring } = options;
    if (!keyring.keys[keyring.activeKeyId]) throw new CollaborationTicketIssuerError("configuration", "Active ticket signing key is missing");
    for (const [keyId, seed] of Object.entries(keyring.keys)) this.loadKey(keyId, seed, true);
    for (const [keyId, seed] of Object.entries(keyring.retired ?? {})) if (!this.signingKeys.has(keyId)) this.loadKey(keyId, seed, false);
    if (this.published.length > MAX_KEYS) throw new CollaborationTicketIssuerError("configuration", "Too many ticket signing keys");
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? randomUUID;
    this.createNonce = options.createNonce ?? (() => randomBytes(32).toString("hex"));
  }

  private loadKey(keyId: string, seed: string, signing: boolean): void {
    if (!KEY_ID.test(keyId)) throw new CollaborationTicketIssuerError("configuration", "Ticket signing key id is invalid");
    let key: KeyObject;
    try {
      key = ed25519PrivateKeyFromSeed(seed);
    } catch (error: unknown) {
      throw new CollaborationTicketIssuerError("configuration", error instanceof Error ? error.message : "Ticket signing key is invalid");
    }
    if (signing) this.signingKeys.set(keyId, key);
    this.published.push({ keyId, algorithm: "ed25519", publicKey: ed25519PublicKeyRaw(key) });
  }

  /** Verification keys homes accept, active first then rotation overlap. */
  publicKeys(): Array<z.infer<typeof CollaborationRuntimePublicKeySchema>> {
    return this.published.map((key) => ({ ...key }));
  }

  async issue(input: { actorId: string; request: unknown }): Promise<IssuedConnectionTicket> {
    const request = CollaborationConnectionRequestSchema.safeParse(input.request);
    if (!request.success) throw new CollaborationTicketIssuerError("invalid_request", "Connection request is invalid");
    const { scopeId, purpose, proofPublicKey } = request.data;
    const [directory, status, organizationId] = await Promise.all([
      this.options.repository.getDirectoryRoute(scopeId),
      this.options.repository.getScopeActorStatus(scopeId, input.actorId),
      this.options.resolveOrganization(scopeId),
    ]);
    // Existence is never disclosed: every denial is the same not-found.
    if (!directory || !organizationId || status === "revoked") throw denied();
    const pendingGrantId = !status && directory.audience === "organization"
      ? directory.organizationGrantId : null;
    if (!status && (!pendingGrantId || purpose !== "direct_session")) throw denied();
    if (status === "invited" && purpose !== "direct_session") throw denied();
    if (purpose === "terminal" && directory.kind !== "terminal") throw denied();
    if (!(await this.options.projection.isCurrentMember({ organizationId, actorId: input.actorId }))) throw denied();
    // The endpoint proves the home is enrolled for this owner; the ticket binds
    // the resource's own authority generation, because one home hosts scopes at
    // different generations (a project at N, a standalone Chat at 1).
    const endpoint = await this.options.endpoints.resolveEnrolled(directory.runtimeId);
    if (!endpoint || endpoint.ownerId !== directory.ownerId) {
      throw new CollaborationTicketIssuerError("unavailable", "Collaboration home is unavailable");
    }
    const issuedAt = this.now();
    const lastControlAt = endpoint.lastControlAt ? Date.parse(endpoint.lastControlAt) : Number.NaN;
    if (!Number.isFinite(lastControlAt) || issuedAt.getTime() - lastControlAt > HOME_LIVENESS_WINDOW_MS) {
      throw new CollaborationTicketIssuerError("host_offline", "Collaboration home is offline");
    }
    const ticket = {
      protocolVersion: COLLABORATION_DIRECT_PROTOCOL_VERSION,
      ticketId: this.createId(),
      nonce: this.createNonce(),
      actorId: input.actorId,
      organizationId,
      resource: { scopeId, kind: directory.kind, ...(pendingGrantId ? { pendingGrantId } : {}) },
      purpose,
      runtime: { runtimeId: endpoint.runtimeId, authorityGeneration: directory.authorityGeneration },
      proofKeyThumbprint: proofKeyThumbprint(proofPublicKey),
      maxActions: request.data.maxActions ?? COLLABORATION_DIRECT_LIMITS.maxTicketActions,
      issuedAt: issuedAt.toISOString(),
      expiresAt: new Date(issuedAt.getTime() + COLLABORATION_DIRECT_LIMITS.ticketTtlSeconds * 1_000).toISOString(),
    };
    const keyId = this.options.keyring.activeKeyId;
    const signedTicket = CollaborationSignedConnectionTicketSchema.parse({
      ticket,
      keyId,
      signature: signEd25519(this.signingKeys.get(keyId)!, ticketSigningPayload(ticket)),
    });
    return {
      signedTicket,
      endpoint: { origin: this.options.relayOrigin, protocolVersion: COLLABORATION_DIRECT_PROTOCOL_VERSION },
    };
  }

  /** An owner-runtime setup ticket never names a scope and cannot authorize shared content. */
  async issueOwnerRuntime(input: { actorId: string; request: unknown }): Promise<IssuedOwnerRuntimeTicket> {
    const request = CollaborationOwnerRuntimeConnectionRequestSchema.safeParse(input.request);
    if (!request.success) throw new CollaborationTicketIssuerError("invalid_request", "Connection request is invalid");
    const endpoint = await this.options.endpoints.resolveEnrolled(request.data.runtimeId);
    if (!endpoint || endpoint.ownerId !== input.actorId) throw denied();
    if (!(await this.options.projection.isCurrentMember({ organizationId: request.data.organizationId, actorId: input.actorId }))) throw denied();
    const issuedAt = this.now();
    const lastControlAt = endpoint.lastControlAt ? Date.parse(endpoint.lastControlAt) : Number.NaN;
    if (!Number.isFinite(lastControlAt) || issuedAt.getTime() - lastControlAt > HOME_LIVENESS_WINDOW_MS) {
      throw new CollaborationTicketIssuerError("host_offline", "Collaboration home is offline");
    }
    const ticket = {
      protocolVersion: COLLABORATION_DIRECT_PROTOCOL_VERSION,
      ticketId: this.createId(), nonce: this.createNonce(), actorId: input.actorId,
      organizationId: request.data.organizationId,
      resource: { kind: "owner_runtime" as const }, purpose: "owner_runtime" as const,
      runtime: { runtimeId: endpoint.runtimeId, authorityGeneration: endpoint.authorityGeneration },
      proofKeyThumbprint: proofKeyThumbprint(request.data.proofPublicKey),
      maxActions: 32,
      issuedAt: issuedAt.toISOString(),
      expiresAt: new Date(issuedAt.getTime() + COLLABORATION_DIRECT_LIMITS.ticketTtlSeconds * 1_000).toISOString(),
    };
    const keyId = this.options.keyring.activeKeyId;
    return {
      signedTicket: CollaborationSignedOwnerRuntimeTicketSchema.parse({
        ticket, keyId, signature: signEd25519(this.signingKeys.get(keyId)!, ticketSigningPayload(ticket)),
      }),
      endpoint: { origin: this.options.relayOrigin, protocolVersion: COLLABORATION_DIRECT_PROTOCOL_VERSION },
    };
  }
}

function denied(): CollaborationTicketIssuerError {
  return new CollaborationTicketIssuerError("not_found", "Collaboration resource not found");
}
