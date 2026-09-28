/** Backend-only Clerk organization administration. Never expose upstream errors to callers. */
import { z } from "zod/v4";
import { ClerkActorIdSchema, ClerkOrganizationIdSchema } from "./roles.js";

const BASE = "https://api.clerk.com/v1";
const PAGE_SIZE = 100;
const MAX_MEMBERSHIPS = 1_000;
const MARKER_LOOKUP_CONCURRENCY = 16;
const MAX_BYTES = 64 * 1024;
const TIMEOUT_MS = 10_000;
const INVITATION_PAGE_SIZE = 50;
const InvitationIdSchema = z.string().regex(/^orginv_[A-Za-z0-9_]{1,120}$/);
const InvitationSchema = z.object({
  id: InvitationIdSchema,
  organization_id: ClerkOrganizationIdSchema,
  email_address: z.email().max(320),
  role: z.enum(["org:admin", "org:member"]),
  status: z.string().max(32).optional(),
  expires_at: z.number().int().nonnegative(),
}).passthrough();
const InvitationPageSchema = z.object({
  data: z.array(InvitationSchema).max(INVITATION_PAGE_SIZE),
  total_count: z.number().int().nonnegative(),
}).passthrough();
const RequestIdSchema = z.uuid();
const OrganizationSchema = z.object({
  id: ClerkOrganizationIdSchema,
  private_metadata: z.object({ matrixCreateRequestId: z.string().max(128).optional() }).passthrough().nullable().optional(),
}).passthrough();
const MembershipPageSchema = z.object({
  data: z.array(z.object({ organization: z.object({
    id: ClerkOrganizationIdSchema,
    created_at: z.number().int().nonnegative(),
  }).passthrough() }).passthrough()).max(PAGE_SIZE),
  total_count: z.number().int().nonnegative().optional(),
}).passthrough();

export type OrganizationMarkerLookup =
  | { kind: "found"; organizationId: string }
  | { kind: "absent" }
  | { kind: "inconclusive" };

export interface ClerkOrganizationAdmin {
  createOrganization(input: { actorId: string; name: string; requestId: string }): Promise<{ organizationId: string }>;
  findCreatedOrganization(input: { actorId: string; requestId: string; createdAt: Date }): Promise<OrganizationMarkerLookup>;
  createInvitation(input: { organizationId: string; actorId: string; emailAddress: string; role: "org:admin" | "org:member"; redirectUrl: string; requestId: string }): Promise<{ invitationId: string; expiresAt: Date }>;
  listInvitations(input: { organizationId: string; limit: number; offset: number }): Promise<{ invitations: Array<{ invitationId: string; emailAddress: string; role: string; status: string; expiresAt: Date }>; totalCount: number }>;
  revokeInvitation(input: { organizationId: string; invitationId: string; actorId: string }): Promise<void>;
}

export class ClerkOrganizationAdminClient implements ClerkOrganizationAdmin {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: { secretKey: string; fetchImpl?: typeof fetch }) {
    if (!options.secretKey) throw new Error("Clerk secret key is required");
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async createOrganization(input: { actorId: string; name: string; requestId: string }): Promise<{ organizationId: string }> {
    const actorId = ClerkActorIdSchema.parse(input.actorId);
    const requestId = RequestIdSchema.parse(input.requestId);
    const organization = OrganizationSchema.parse(await this.request(`${BASE}/organizations`, {
      method: "POST",
      body: JSON.stringify({
        name: input.name,
        created_by: actorId,
        private_metadata: { matrixCreateRequestId: requestId },
      }),
    }));
    return { organizationId: organization.id };
  }

  async createInvitation(input: { organizationId: string; actorId: string; emailAddress: string; role: "org:admin" | "org:member"; redirectUrl: string; requestId: string }): Promise<{ invitationId: string; expiresAt: Date }> {
    const organizationId = ClerkOrganizationIdSchema.parse(input.organizationId);
    const actorId = ClerkActorIdSchema.parse(input.actorId);
    const requestId = RequestIdSchema.parse(input.requestId);
    const invite = InvitationSchema.parse(await this.request(`${BASE}/organizations/${encodeURIComponent(organizationId)}/invitations`, {
      method: "POST",
      body: JSON.stringify({ email_address: input.emailAddress, inviter_user_id: actorId, role: input.role, redirect_url: input.redirectUrl,
        private_metadata: { matrixInviteRequestId: requestId } }),
    }));
    if (invite.organization_id !== organizationId || invite.email_address.toLowerCase() !== input.emailAddress.toLowerCase()) {
      throw new Error("Clerk invitation identity mismatch");
    }
    return { invitationId: invite.id, expiresAt: new Date(invite.expires_at) };
  }

  async listInvitations(input: { organizationId: string; limit: number; offset: number }): Promise<{ invitations: Array<{ invitationId: string; emailAddress: string; role: string; status: string; expiresAt: Date }>; totalCount: number }> {
    const organizationId = ClerkOrganizationIdSchema.parse(input.organizationId);
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > INVITATION_PAGE_SIZE || !Number.isInteger(input.offset) || input.offset < 0 || input.offset > 500) throw new Error("Invalid invitation page");
    const url = new URL(`${BASE}/organizations/${encodeURIComponent(organizationId)}/invitations`);
    url.searchParams.set("limit", String(input.limit));
    url.searchParams.set("offset", String(input.offset));
    url.searchParams.set("status", "pending");
    const page = InvitationPageSchema.parse(await this.request(url.toString()));
    if (page.data.some((item) => item.organization_id !== organizationId)) throw new Error("Clerk invitation organization mismatch");
    return {
      invitations: page.data.filter((item) => item.status === "pending")
        .map((item) => ({ invitationId: item.id, emailAddress: item.email_address, role: item.role, status: "pending", expiresAt: new Date(item.expires_at) })),
      totalCount: page.total_count,
    };
  }

  async revokeInvitation(input: { organizationId: string; invitationId: string; actorId: string }): Promise<void> {
    const organizationId = ClerkOrganizationIdSchema.parse(input.organizationId);
    const invitationId = InvitationIdSchema.parse(input.invitationId);
    const actorId = ClerkActorIdSchema.parse(input.actorId);
    const response = InvitationSchema.parse(await this.request(`${BASE}/organizations/${encodeURIComponent(organizationId)}/invitations/${encodeURIComponent(invitationId)}/revoke`, {
      method: "POST", body: JSON.stringify({ requesting_user_id: actorId }),
    }));
    if (response.id !== invitationId || response.organization_id !== organizationId) throw new Error("Clerk invitation revoke mismatch");
  }

  async findCreatedOrganization(input: { actorId: string; requestId: string; createdAt: Date }): Promise<OrganizationMarkerLookup> {
    const actorId = ClerkActorIdSchema.parse(input.actorId);
    const requestId = RequestIdSchema.parse(input.requestId);
    // Membership order can differ from organization creation order. Scan the
    // bounded complete result before declaring the marker absent.
    // A complete negative lookup can be retried. Bound one pass so the durable
    // row lease cannot expire while this worker is still calling Clerk.
    const deadline = Date.now() + 90_000;
    try {
      for (let offset = 0; offset <= MAX_MEMBERSHIPS; offset += PAGE_SIZE) {
        if (Date.now() >= deadline) return { kind: "inconclusive" };
        const url = new URL(`${BASE}/users/${encodeURIComponent(actorId)}/organization_memberships`);
        url.searchParams.set("limit", String(PAGE_SIZE));
        url.searchParams.set("offset", String(offset));
        const page = MembershipPageSchema.parse(await this.request(url.toString(), undefined, deadline));
        if (offset + page.data.length > MAX_MEMBERSHIPS || (page.total_count !== undefined && page.total_count > MAX_MEMBERSHIPS)) {
          return { kind: "inconclusive" };
        }
        for (let start = 0; start < page.data.length; start += MARKER_LOOKUP_CONCURRENCY) {
          if (Date.now() >= deadline) return { kind: "inconclusive" };
          const batch = page.data.slice(start, start + MARKER_LOOKUP_CONCURRENCY);
          const results = await Promise.allSettled(batch.map(async (membership) => {
            const organization = OrganizationSchema.parse(await this.request(
              `${BASE}/organizations/${encodeURIComponent(membership.organization.id)}`, undefined, deadline));
            if (organization.id !== membership.organization.id) throw new Error("Clerk organization identity changed");
            return organization;
          }));
          const found = results.find((result) => result.status === "fulfilled"
            && result.value.private_metadata?.matrixCreateRequestId === requestId);
          if (found?.status === "fulfilled") return { kind: "found", organizationId: found.value.id };
          if (Date.now() >= deadline || results.some((result) => result.status === "rejected")) {
            return { kind: "inconclusive" };
          }
        }
        if (page.data.length < PAGE_SIZE || (page.total_count !== undefined && offset + page.data.length >= page.total_count)) {
          return { kind: "absent" };
        }
        if (offset + PAGE_SIZE >= MAX_MEMBERSHIPS) return { kind: "inconclusive" };
      }
    } catch (error: unknown) {
      console.warn("[organizations] create marker lookup inconclusive", error instanceof Error ? error.name : "UnknownError");
    }
    return { kind: "inconclusive" };
  }

  private async request(url: string, init?: { method: "POST"; body: string }, deadline?: number): Promise<unknown> {
    const remainingMs = deadline === undefined ? TIMEOUT_MS : Math.min(TIMEOUT_MS, deadline - Date.now());
    if (remainingMs <= 0) throw new Error("Clerk organization request deadline reached");
    const response = await this.fetchImpl(url, {
      method: init?.method ?? "GET",
      headers: {
        authorization: `Bearer ${this.options.secretKey}`,
        accept: "application/json",
        ...(init ? { "content-type": "application/json" } : {}),
      },
      ...(init ? { body: init.body } : {}),
      signal: AbortSignal.timeout(remainingMs),
      redirect: "error",
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("Clerk organization request failed");
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Clerk organization response missing");
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BYTES) {
        await reader.cancel();
        throw new Error("Clerk organization response exceeded limit");
      }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  }
}
