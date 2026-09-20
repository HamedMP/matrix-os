import { z } from "zod/v4";

import { canonicalReferenceId } from "#canonical-chat-primitives";
import { CollaborationActorIdSchema, CollaborationIdSchema, CollaborationOrganizationIdSchema, CollaborationRevisionSchema } from "#collaboration";
import { IsoTimestampSchema } from "#contract-primitives";

/**
 * @deferred S14 (organization billing, invitation quotes and member-computer
 * assignments) is not on the V1 release path. Nothing in V1 charges an
 * organization or provisions a computer. These minimal types keep the later
 * administration release compatible with the V1 run binding.
 */

/** @deferred Payer principal reference; V1 runs are always owner-funded. */
export const OrganizationPayerRefSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("personal"), actorId: CollaborationActorIdSchema }).strict(),
  z.object({ kind: z.literal("organization"), organizationId: CollaborationOrganizationIdSchema }).strict(),
]);

/** Immutable run account-payer binding captured at reservation; settlement and refund use it even if sponsorship later changes. */
export const CollaborationRunPayerBindingSchema = z.object({
  runId: canonicalReferenceId(160),
  payer: OrganizationPayerRefSchema,
  accessSourceId: canonicalReferenceId(128),
  reservedAt: IsoTimestampSchema,
}).strict();

/** @deferred */
export const OrganizationInviteQuoteSchema = z.object({
  id: CollaborationIdSchema,
  organizationId: CollaborationOrganizationIdSchema,
  strategy: z.enum(["no_compute", "sponsor_existing", "provision_member"]),
  currency: z.string().regex(/^[A-Z]{3}$/),
  incrementalMonthlyMinorUnits: z.number().int().nonnegative().max(1_000_000_000),
  currentMonthlyMinorUnits: z.number().int().nonnegative().max(1_000_000_000),
  quoteDigest: z.string().regex(/^[a-f0-9]{64}$/),
  expiresAt: IsoTimestampSchema,
  revision: CollaborationRevisionSchema,
}).strict();

/** @deferred */
export const OrganizationMemberComputerAssignmentSchema = z.object({
  organizationId: CollaborationOrganizationIdSchema,
  actorId: CollaborationActorIdSchema,
  runtimeId: canonicalReferenceId(128),
  lifecycle: z.enum(["pending", "active", "ending", "ended"]),
  payer: OrganizationPayerRefSchema,
  revision: CollaborationRevisionSchema,
}).strict();

export type OrganizationPayerRef = z.infer<typeof OrganizationPayerRefSchema>;
export type CollaborationRunPayerBinding = z.infer<typeof CollaborationRunPayerBindingSchema>;
export type OrganizationInviteQuote = z.infer<typeof OrganizationInviteQuoteSchema>;
export type OrganizationMemberComputerAssignment = z.infer<typeof OrganizationMemberComputerAssignmentSchema>;
