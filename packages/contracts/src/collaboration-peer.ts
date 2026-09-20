import { z } from "zod/v4";

import { CollaborationActorIdSchema, CollaborationIdSchema } from "#collaboration";
import {
  COLLABORATION_DIRECT_LIMITS,
  CollaborationLogicalRuntimeRefSchema,
  CollaborationProtocolVersionSchema,
} from "#collaboration-direct";
import { IsoTimestampSchema } from "#contract-primitives";

/**
 * @deferred S13 (computer-to-computer transfer) and S11 (peer integration
 * delegation) are not on the V1 release path. These are the minimal types the
 * V1 contract rows reference so later packets extend rather than replace them.
 * No V1 route is wired to them.
 */

const HEX_DIGEST = /^[a-f0-9]{64}$/;
const HEX_NONCE = /^[a-f0-9]{32,128}$/;

/** @deferred */
export const CollaborationPeerPurposeSchema = z.enum(["transfer", "policy_sync"]);

/** @deferred Exact actor-delegated operation ticket naming both endpoints. */
export const CollaborationPeerOperationTicketSchema = z.object({
  protocolVersion: CollaborationProtocolVersionSchema,
  operationId: CollaborationIdSchema,
  purpose: CollaborationPeerPurposeSchema,
  actorId: CollaborationActorIdSchema,
  scopeId: CollaborationIdSchema,
  source: CollaborationLogicalRuntimeRefSchema,
  target: CollaborationLogicalRuntimeRefSchema,
  payloadDigest: z.string().regex(HEX_DIGEST),
  nonce: z.string().regex(HEX_NONCE),
  issuedAt: IsoTimestampSchema,
  expiresAt: IsoTimestampSchema,
}).strict().superRefine((ticket, ctx) => {
  if (ticket.source.runtimeId === ticket.target.runtimeId) {
    ctx.addIssue({ code: "custom", path: ["target"], message: "Peer operations name two distinct runtimes" });
  }
  const ttl = (Date.parse(ticket.expiresAt) - Date.parse(ticket.issuedAt)) / 1_000;
  if (!(ttl > 0) || ttl > COLLABORATION_DIRECT_LIMITS.ticketTtlSeconds) {
    ctx.addIssue({ code: "custom", path: ["expiresAt"], message: "Peer ticket must expire within the ticket TTL" });
  }
});

/** @deferred */
export const CollaborationPeerSessionRequestSchema = z.object({
  clientRequestId: CollaborationIdSchema,
  ticket: CollaborationPeerOperationTicketSchema,
  keyId: z.string().min(1).max(80).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/),
  signature: z.string().regex(/^[A-Za-z0-9_-]{43,172}$/),
}).strict();

/** @deferred Operation-bound chunk manifest; ids and lengths are checked against it. */
export const CollaborationPeerChunkManifestSchema = z.object({
  operationId: CollaborationIdSchema,
  inventoryDigest: z.string().regex(HEX_DIGEST),
  chunkBytes: z.literal(8 * 1024 * 1024),
  chunks: z.array(z.object({
    chunkId: z.string().regex(/^[a-f0-9]{8,32}$/),
    byteLength: z.number().int().min(1).max(8 * 1024 * 1024),
    digest: z.string().regex(HEX_DIGEST),
  }).strict()).min(1).max(1_000_000),
}).strict();

export type CollaborationPeerPurpose = z.infer<typeof CollaborationPeerPurposeSchema>;
export type CollaborationPeerOperationTicket = z.infer<typeof CollaborationPeerOperationTicketSchema>;
export type CollaborationPeerSessionRequest = z.infer<typeof CollaborationPeerSessionRequestSchema>;
export type CollaborationPeerChunkManifest = z.infer<typeof CollaborationPeerChunkManifestSchema>;
