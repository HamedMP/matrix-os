/**
 * Clerk organization vocabulary for V1 (S03 / T016).
 *
 * V1 uses Clerk's default roles and no custom permissions: roles carry no
 * application authority, so unknown roles are stored verbatim (bounded) and
 * deny nothing. `collaboration.aiSubmission` is projected from organization
 * public metadata; anything other than the literal "members" is owner-only.
 */
import { z } from "zod/v4";
import type { OrganizationAiSubmission } from "./database.js";

export const CLERK_DEFAULT_ROLES = Object.freeze(["org:admin", "org:member"] as const);
const ROLE_PATTERN = /^[A-Za-z0-9:_.-]{1,64}$/;
const ORGANIZATION_ID_PATTERN = /^org_[A-Za-z0-9]{1,124}$/;
const ACTOR_ID_PATTERN = /^user_[A-Za-z0-9_-]{1,123}$/;
const MEMBERSHIP_ID_PATTERN = /^[A-Za-z0-9_:-]{1,128}$/;

export const ClerkOrganizationIdSchema = z.string().regex(ORGANIZATION_ID_PATTERN);
export const ClerkActorIdSchema = z.string().regex(ACTOR_ID_PATTERN);
export const ClerkRoleSchema = z.string().regex(ROLE_PATTERN);

export interface OrganizationSnapshot {
  organizationId: string;
  name: string;
  slug: string;
  aiSubmission: OrganizationAiSubmission;
  sourceUpdatedAt: Date;
  lifecycle?: "active" | "deleted";
}

export interface MembershipSnapshot {
  membershipId: string;
  actorId: string;
  role: string;
  sourceUpdatedAt: Date;
}

export type ClerkOrganizationEventType =
  | "organization.created"
  | "organization.updated"
  | "organization.deleted"
  | "organizationMembership.created"
  | "organizationMembership.updated"
  | "organizationMembership.deleted";

export interface ClerkOrganizationSourceEvent {
  eventId: string;
  type: ClerkOrganizationEventType;
  occurredAt: Date;
  organization: OrganizationSnapshot;
  membership?: MembershipSnapshot;
}

export function normalizeClerkRole(role: unknown): string {
  const parsed = ClerkRoleSchema.safeParse(role);
  return parsed.success ? parsed.data : "org:member";
}

export function projectAiSubmission(publicMetadata: unknown): OrganizationAiSubmission {
  if (!publicMetadata || typeof publicMetadata !== "object") return "owner_only";
  const collaboration = (publicMetadata as { collaboration?: unknown }).collaboration;
  if (!collaboration || typeof collaboration !== "object") return "owner_only";
  return (collaboration as { aiSubmission?: unknown }).aiSubmission === "members" ? "members" : "owner_only";
}

const ClerkTimestampSchema = z.number().int().nonnegative().max(8.64e15);
const SafeLabelSchema = z.string().trim().min(1).max(200);

const ClerkOrganizationDataSchema = z.object({
  id: ClerkOrganizationIdSchema,
  name: SafeLabelSchema.optional(),
  slug: SafeLabelSchema.optional(),
  public_metadata: z.unknown().optional(),
  created_at: ClerkTimestampSchema.optional(),
  updated_at: ClerkTimestampSchema.optional(),
  deleted: z.boolean().optional(),
}).passthrough();

const ClerkMembershipDataSchema = z.object({
  id: z.string().regex(MEMBERSHIP_ID_PATTERN),
  role: z.unknown().optional(),
  created_at: ClerkTimestampSchema.optional(),
  updated_at: ClerkTimestampSchema.optional(),
  organization: ClerkOrganizationDataSchema,
  public_user_data: z.object({ user_id: ClerkActorIdSchema }).passthrough(),
}).passthrough();

const ClerkWebhookEnvelopeSchema = z.object({
  type: z.string().max(80),
  data: z.unknown(),
  timestamp: ClerkTimestampSchema.optional(),
}).passthrough();

export type ParsedClerkWebhook =
  | { kind: "organization"; event: ClerkOrganizationSourceEvent }
  | { kind: "ignored"; type: string }
  | { kind: "invalid" };

function organizationFromData(data: z.infer<typeof ClerkOrganizationDataSchema>, occurredAt: Date, deleted = false): OrganizationSnapshot {
  const sourceUpdatedAt = data.updated_at !== undefined ? new Date(data.updated_at) : occurredAt;
  return {
    organizationId: data.id,
    name: data.name ?? data.slug ?? data.id,
    slug: data.slug ?? data.id,
    aiSubmission: projectAiSubmission(data.public_metadata),
    sourceUpdatedAt,
    lifecycle: deleted || data.deleted ? "deleted" : "active",
  };
}

/**
 * Maps one verified Clerk webhook body to a normalized source event. Unknown
 * event types are ignored (acknowledged, never applied); malformed payloads
 * for known types are invalid and rejected.
 */
export function parseClerkOrganizationWebhook(eventId: string, body: unknown): ParsedClerkWebhook {
  const envelope = ClerkWebhookEnvelopeSchema.safeParse(body);
  if (!envelope.success) return { kind: "invalid" };
  const type = envelope.data.type;
  const occurredAt = envelope.data.timestamp !== undefined ? new Date(envelope.data.timestamp) : new Date();
  if (type === "organization.created" || type === "organization.updated" || type === "organization.deleted") {
    const data = ClerkOrganizationDataSchema.safeParse(envelope.data.data);
    if (!data.success) return { kind: "invalid" };
    return {
      kind: "organization",
      event: { eventId, type, occurredAt, organization: organizationFromData(data.data, occurredAt, type === "organization.deleted") },
    };
  }
  if (type === "organizationMembership.created" || type === "organizationMembership.updated" || type === "organizationMembership.deleted") {
    const data = ClerkMembershipDataSchema.safeParse(envelope.data.data);
    if (!data.success) return { kind: "invalid" };
    const sourceUpdatedAt = data.data.updated_at !== undefined ? new Date(data.data.updated_at) : occurredAt;
    return {
      kind: "organization",
      event: {
        eventId,
        type,
        occurredAt,
        organization: organizationFromData(data.data.organization, occurredAt),
        membership: {
          membershipId: data.data.id,
          actorId: data.data.public_user_data.user_id,
          role: normalizeClerkRole(data.data.role),
          sourceUpdatedAt,
        },
      },
    };
  }
  return { kind: "ignored", type };
}
