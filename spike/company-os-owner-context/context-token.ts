import { randomUUID } from "node:crypto";
import { jwtVerify, SignJWT } from "jose";
import { z } from "zod/v4";

const UserIdSchema = z.string().regex(/^user_[a-z0-9][a-z0-9_-]{1,127}$/);
const OrganizationIdSchema = z.string().regex(/^org_[a-z0-9][a-z0-9_-]{1,127}$/);
const RuntimeIdSchema = z.string().regex(/^rtm_[a-z0-9][a-z0-9_-]{1,127}$/);
const RuntimeSlotSchema = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/);
const MembershipIdSchema = z.string().regex(/^mem_[a-z0-9][a-z0-9_-]{1,127}$/);
const OrganizationRoleSchema = z.enum(["owner", "admin", "member", "guest"]);

export const OwnerRefSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("user"), id: UserIdSchema }).strict(),
  z.object({ type: z.literal("organization"), id: OrganizationIdSchema }).strict(),
]);

export type OwnerRef = z.infer<typeof OwnerRefSchema>;

export interface MembershipProof {
  id: string;
  actorUserId: string;
  organizationId: string;
  role: z.infer<typeof OrganizationRoleSchema>;
  membershipVersion: number;
  policyVersion: number;
  status: "active" | "revoked";
}

const ContextClaimsSchema = z.object({
  sub: UserIdSchema,
  owner_type: z.enum(["user", "organization"]),
  owner_id: z.string(),
  runtime_id: RuntimeIdSchema,
  runtime_slot: RuntimeSlotSchema,
  membership_id: MembershipIdSchema.optional(),
  org_role: OrganizationRoleSchema.optional(),
  membership_version: z.number().int().nonnegative().optional(),
  policy_version: z.number().int().nonnegative().optional(),
  iat: z.number().int().nonnegative(),
  exp: z.number().int().positive(),
  iss: z.string().url(),
  aud: z.union([z.string(), z.array(z.string())]),
  jti: z.string().uuid(),
}).passthrough();

export class ContextVerificationError extends Error {
  readonly code = "invalid_context";

  constructor() {
    super("Owner context is not valid");
    this.name = "ContextVerificationError";
  }
}

export interface IssueContextTokenInput {
  actorUserId: string;
  owner: OwnerRef;
  runtimeId: string;
  runtimeSlot: string;
  membershipId?: string;
  organizationRole?: MembershipProof["role"];
  membershipVersion?: number;
  policyVersion?: number;
  issuer: string;
  audience: string;
  issuedAt: number;
  expiresAt: number;
  key: Uint8Array;
}

function assertIssueInput(input: IssueContextTokenInput): void {
  const owner = OwnerRefSchema.safeParse(input.owner);
  const common = z.object({
    actorUserId: UserIdSchema,
    runtimeId: RuntimeIdSchema,
    runtimeSlot: RuntimeSlotSchema,
    issuer: z.string().url(),
    audience: z.string().min(1).max(128),
    issuedAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().positive(),
  }).safeParse(input);
  if (!owner.success || !common.success || input.expiresAt <= input.issuedAt) {
    throw new ContextVerificationError();
  }
  if (input.owner.type === "user") {
    if (
      input.owner.id !== input.actorUserId ||
      input.membershipId !== undefined ||
      input.organizationRole !== undefined ||
      input.membershipVersion !== undefined ||
      input.policyVersion !== undefined
    ) {
      throw new ContextVerificationError();
    }
    return;
  }
  const orgProof = z.object({
    membershipId: MembershipIdSchema,
    organizationRole: OrganizationRoleSchema,
    membershipVersion: z.number().int().nonnegative(),
    policyVersion: z.number().int().nonnegative(),
  }).safeParse(input);
  if (!orgProof.success) throw new ContextVerificationError();
}

export async function issueContextToken(input: IssueContextTokenInput): Promise<string> {
  assertIssueInput(input);
  return new SignJWT({
    owner_type: input.owner.type,
    owner_id: input.owner.id,
    runtime_id: input.runtimeId,
    runtime_slot: input.runtimeSlot,
    membership_id: input.membershipId,
    org_role: input.organizationRole,
    membership_version: input.membershipVersion,
    policy_version: input.policyVersion,
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(input.actorUserId)
    .setIssuer(input.issuer)
    .setAudience(input.audience)
    .setIssuedAt(input.issuedAt)
    .setExpirationTime(input.expiresAt)
    .setJti(randomUUID())
    .sign(input.key);
}

export interface VerifyContextTokenOptions {
  key: Uint8Array;
  issuer: string;
  audience: string;
  expectedRuntimeId: string;
  expectedOwner: OwnerRef;
  now: number;
  getMembership(id: string): Promise<MembershipProof | null>;
}

export interface VerifiedOwnerContext {
  actorUserId: string;
  owner: OwnerRef;
  runtimeId: string;
  runtimeSlot: string;
  membershipId?: string;
  organizationRole?: MembershipProof["role"];
  membershipVersion?: number;
  policyVersion?: number;
}

function audienceContains(audience: string | string[], expected: string): boolean {
  return Array.isArray(audience) ? audience.includes(expected) : audience === expected;
}

export async function verifyContextToken(
  token: string,
  options: VerifyContextTokenOptions,
): Promise<VerifiedOwnerContext> {
  try {
    const verified = await jwtVerify(token, options.key, {
      algorithms: ["HS256"],
      issuer: options.issuer,
      audience: options.audience,
      currentDate: new Date(options.now * 1000),
      clockTolerance: 0,
    });
    const parsed = ContextClaimsSchema.parse(verified.payload);
    if (!audienceContains(parsed.aud, options.audience)) throw new Error("audience mismatch");
    const owner = OwnerRefSchema.parse({ type: parsed.owner_type, id: parsed.owner_id });
    if (
      parsed.runtime_id !== RuntimeIdSchema.parse(options.expectedRuntimeId) ||
      owner.type !== options.expectedOwner.type ||
      owner.id !== options.expectedOwner.id
    ) {
      throw new Error("binding mismatch");
    }

    if (owner.type === "user") {
      if (
        owner.id !== parsed.sub ||
        parsed.membership_id !== undefined ||
        parsed.org_role !== undefined ||
        parsed.membership_version !== undefined ||
        parsed.policy_version !== undefined
      ) {
        throw new Error("personal actor mismatch");
      }
    } else {
      if (
        !parsed.membership_id ||
        !parsed.org_role ||
        parsed.membership_version === undefined ||
        parsed.policy_version === undefined
      ) {
        throw new Error("membership proof missing");
      }
      const proof = await options.getMembership(parsed.membership_id);
      if (
        !proof ||
        proof.status !== "active" ||
        proof.id !== parsed.membership_id ||
        proof.actorUserId !== parsed.sub ||
        proof.organizationId !== owner.id ||
        proof.role !== parsed.org_role ||
        proof.membershipVersion !== parsed.membership_version ||
        proof.policyVersion !== parsed.policy_version
      ) {
        throw new Error("membership stale");
      }
    }

    return {
      actorUserId: parsed.sub,
      owner,
      runtimeId: parsed.runtime_id,
      runtimeSlot: parsed.runtime_slot,
      membershipId: parsed.membership_id,
      organizationRole: parsed.org_role,
      membershipVersion: parsed.membership_version,
      policyVersion: parsed.policy_version,
    };
  } catch {
    throw new ContextVerificationError();
  }
}
