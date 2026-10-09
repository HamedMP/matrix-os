import { z } from "zod/v4";
import { CollaborationOrganizationIdSchema } from "#collaboration-identity";

/** Clerk's two built-in organization roles used by Matrix organization management. */
export const OrganizationManagementRoleSchema = z.enum(["org:admin", "org:member"]);

export const OrganizationManagementSummarySchema = z.object({
  organizationId: CollaborationOrganizationIdSchema,
  name: z.string().trim().min(1).max(200),
  slug: z.string().trim().min(1).max(200),
  role: OrganizationManagementRoleSchema,
  memberCount: z.number().int().nonnegative().max(2_000),
  aiSubmission: z.enum(["members", "owner_only"]),
  membershipEpoch: z.number().int().nonnegative(),
}).strict();

export const OrganizationManagementListSchema = z.object({
  complete: z.boolean(),
  organizations: z.array(OrganizationManagementSummarySchema).max(100),
}).strict();

export const OrganizationManagementMemberSchema = z.object({
  actorId: z.string().regex(/^user_[A-Za-z0-9_-]{1,123}$/),
  displayName: z.string().trim().min(1).max(200),
  emailAddress: z.email().max(320).optional(),
  role: OrganizationManagementRoleSchema,
  joinedAt: z.iso.datetime(),
}).strict();

export const OrganizationManagementMembersPageSchema = z.object({
  members: z.array(OrganizationManagementMemberSchema).max(100),
  nextCursor: z.string().min(1).max(256).regex(/^[A-Za-z0-9_-]+$/).optional(),
}).strict();

export const OrganizationManagementInvitationSchema = z.object({
  invitationId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_:-]+$/),
  emailAddress: z.email().max(320),
  role: OrganizationManagementRoleSchema,
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
}).strict();

export const OrganizationManagementInvitationsSchema = z.object({
  invitations: z.array(OrganizationManagementInvitationSchema).max(100),
}).strict();

export const ORGANIZATION_LOGO_MAX_BYTES = 10 * 1024 * 1024;

export const OrganizationManagementRenameInputSchema = z.object({
  name: z.string().trim().min(1).max(200),
}).strict();

export const OrganizationManagementInviteInputSchema = z.object({
  emailAddresses: z.array(z.email().max(320)).min(1).max(10)
    .refine((emails) => new Set(emails.map((email) => email.toLowerCase())).size === emails.length),
  role: OrganizationManagementRoleSchema,
}).strict();

export const OrganizationManagementRoleInputSchema = z.object({
  role: OrganizationManagementRoleSchema,
}).strict();

export const OrganizationManagementMutationResultSchema = z.object({ ok: z.literal(true) }).strict();

export type OrganizationManagementRole = z.infer<typeof OrganizationManagementRoleSchema>;
export type OrganizationManagementSummary = z.infer<typeof OrganizationManagementSummarySchema>;
export type OrganizationManagementMember = z.infer<typeof OrganizationManagementMemberSchema>;
export type OrganizationManagementInvitation = z.infer<typeof OrganizationManagementInvitationSchema>;
export type OrganizationManagementInviteInput = z.infer<typeof OrganizationManagementInviteInputSchema>;
