/**
 * Clerk Backend API upstream for organization reconciliation (S03 / T016).
 * Bounded pages, bounded response bodies, timeouts on every call, no
 * redirects. Organizations larger than the member cap fail verification
 * rather than being partially projected.
 */
import { z } from "zod/v4";
import { OrganizationManagementRoleSchema, type OrganizationManagementRole } from "@matrix-os/contracts";
import type { ClerkOrganizationUpstream } from "./projection.js";
import { ClerkActorIdSchema, ClerkOrganizationIdSchema, normalizeClerkRole, projectAiSubmission } from "./roles.js";
import type { OrganizationManagementUpstream } from "./management.js";

const CLERK_API_BASE = "https://api.clerk.com/v1";
const REQUEST_TIMEOUT_MS = 10_000;
const PAGE_SIZE = 100;
const MAX_ACTOR_ORGANIZATIONS = 100;
const MAX_MEMBERS = 2_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const InvitationIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9_:-]+$/);

const ClerkOrganizationSchema = z.object({
  id: ClerkOrganizationIdSchema,
  name: z.string().trim().min(1).max(200).optional(),
  slug: z.string().trim().min(1).max(200).optional(),
  public_metadata: z.unknown().optional(),
  updated_at: z.number().int().nonnegative().optional(),
}).passthrough();

const ClerkMembershipPageSchema = z.object({
  data: z.array(z.object({
    id: z.string().regex(/^[A-Za-z0-9_:-]{1,128}$/),
    role: z.unknown().optional(),
    updated_at: z.number().int().nonnegative().optional(),
    public_user_data: z.object({ user_id: ClerkActorIdSchema }).passthrough(),
  }).passthrough()).max(PAGE_SIZE),
  total_count: z.number().int().nonnegative().optional(),
}).passthrough();

const ClerkActorMembershipPageSchema = z.object({
  data: z.array(z.object({
    id: z.string().regex(/^[A-Za-z0-9_:-]{1,128}$/),
    organization: z.object({ id: ClerkOrganizationIdSchema }).passthrough(),
  }).passthrough()).max(MAX_ACTOR_ORGANIZATIONS),
  total_count: z.number().int().nonnegative(),
}).passthrough();

const ClerkInvitationPageSchema = z.object({
  data: z.array(z.object({
    id: z.string().min(1).max(128).regex(/^[A-Za-z0-9_:-]+$/),
    email_address: z.email().max(320),
    role: z.string().min(1).max(64),
    created_at: z.number().int().nonnegative(),
    expires_at: z.number().int().nonnegative(),
  }).passthrough()).max(PAGE_SIZE),
}).passthrough();

export class ClerkOrganizationUpstreamClient implements ClerkOrganizationUpstream, OrganizationManagementUpstream {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: { secretKey: string; fetchImpl?: typeof fetch; now?: () => Date }) {
    if (!options.secretKey) throw new Error("Clerk secret key is required");
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async listOrganizationsForActor(actorId: string): Promise<string[]> {
    const id = ClerkActorIdSchema.parse(actorId);
    const url = new URL(`${CLERK_API_BASE}/users/${encodeURIComponent(id)}/organization_memberships`);
    url.searchParams.set("limit", String(MAX_ACTOR_ORGANIZATIONS));
    url.searchParams.set("offset", "0");
    const page = ClerkActorMembershipPageSchema.parse(await this.getJson(url.toString()));
    if (page.total_count > MAX_ACTOR_ORGANIZATIONS) {
      throw new Error("Actor exceeds the supported organization count");
    }
    return [...new Set(page.data.map((membership) => membership.organization.id))];
  }

  async listMembers(organizationId: string): ReturnType<ClerkOrganizationUpstream["listMembers"]> {
    const id = ClerkOrganizationIdSchema.parse(organizationId);
    const now = this.options.now?.() ?? new Date();
    const organization = ClerkOrganizationSchema.parse(await this.getJson(`${CLERK_API_BASE}/organizations/${encodeURIComponent(id)}`));
    const members: Awaited<ReturnType<ClerkOrganizationUpstream["listMembers"]>>["members"] = [];
    // One extra page beyond the cap is fetched only to prove the organization is not larger
    // than the cap; an organization with exactly MAX_MEMBERS members is accepted.
    for (let offset = 0; offset <= MAX_MEMBERS; offset += PAGE_SIZE) {
      const url = new URL(`${CLERK_API_BASE}/organizations/${encodeURIComponent(id)}/memberships`);
      url.searchParams.set("limit", String(PAGE_SIZE));
      url.searchParams.set("offset", String(offset));
      const page = ClerkMembershipPageSchema.parse(await this.getJson(url.toString()));
      for (const entry of page.data) {
        members.push({
          membershipId: entry.id,
          actorId: entry.public_user_data.user_id,
          role: normalizeClerkRole(entry.role),
          sourceUpdatedAt: entry.updated_at !== undefined ? new Date(entry.updated_at) : now,
        });
      }
      if (members.length > MAX_MEMBERS || (page.total_count !== undefined && page.total_count > MAX_MEMBERS)) {
        throw new Error("Organization exceeds the supported member count");
      }
      if (page.data.length < PAGE_SIZE) break;
      if (members.length === MAX_MEMBERS && page.total_count !== undefined && page.total_count <= MAX_MEMBERS) break;
    }
    return {
      organization: {
        organizationId: organization.id,
        name: organization.name ?? organization.slug ?? organization.id,
        slug: organization.slug ?? organization.id,
        aiSubmission: projectAiSubmission(organization.public_metadata),
        sourceUpdatedAt: organization.updated_at !== undefined ? new Date(organization.updated_at) : now,
        lifecycle: "active",
      },
      members,
    };
  }

  async listPendingInvitations(organizationId: string) {
    const id = ClerkOrganizationIdSchema.parse(organizationId);
    const url = new URL(`${CLERK_API_BASE}/organizations/${encodeURIComponent(id)}/invitations/pending`);
    url.searchParams.set("limit", String(PAGE_SIZE));
    url.searchParams.set("offset", "0");
    const page = ClerkInvitationPageSchema.parse(await this.getJson(url.toString()));
    return page.data.map((invitation) => ({
      invitationId: invitation.id,
      emailAddress: invitation.email_address,
      role: invitation.role,
      createdAt: new Date(invitation.created_at),
      expiresAt: new Date(invitation.expires_at),
    }));
  }

  async renameOrganization(organizationId: string, name: string): Promise<void> {
    const id = ClerkOrganizationIdSchema.parse(organizationId);
    const normalized = z.string().trim().min(1).max(200).parse(name);
    await this.sendJson(`${CLERK_API_BASE}/organizations/${encodeURIComponent(id)}`, "PATCH", { name: normalized });
  }

  async updateOrganizationLogo(organizationId: string, logo: Blob): Promise<void> {
    const id = ClerkOrganizationIdSchema.parse(organizationId);
    const form = new FormData();
    form.set("file", logo);
    await this.send(`${CLERK_API_BASE}/organizations/${encodeURIComponent(id)}/logo`, { method: "PUT", body: form });
  }

  async createInvitations(organizationId: string, emailAddresses: readonly string[], role: OrganizationManagementRole): Promise<void> {
    const id = ClerkOrganizationIdSchema.parse(organizationId);
    const emails = z.array(z.email().max(320)).min(1).max(10).parse(emailAddresses);
    const normalizedRole = OrganizationManagementRoleSchema.parse(role);
    await this.sendJson(`${CLERK_API_BASE}/organizations/${encodeURIComponent(id)}/invitations/bulk`, "POST", {
      email_addresses: emails,
      role: normalizedRole,
    });
  }

  async resendInvitation(organizationId: string, invitationId: string): Promise<void> {
    const invitation = (await this.listPendingInvitations(organizationId))
      .find((candidate) => candidate.invitationId === InvitationIdSchema.parse(invitationId));
    if (!invitation) throw new Error("Clerk invitation is unavailable");
    await this.revokeInvitation(organizationId, invitation.invitationId);
    const id = ClerkOrganizationIdSchema.parse(organizationId);
    await this.sendJson(`${CLERK_API_BASE}/organizations/${encodeURIComponent(id)}/invitations`, "POST", {
      email_address: invitation.emailAddress,
      role: OrganizationManagementRoleSchema.parse(invitation.role),
    });
  }

  async revokeInvitation(organizationId: string, invitationId: string): Promise<void> {
    const id = ClerkOrganizationIdSchema.parse(organizationId);
    const invitation = InvitationIdSchema.parse(invitationId);
    await this.send(`${CLERK_API_BASE}/organizations/${encodeURIComponent(id)}/invitations/${encodeURIComponent(invitation)}/revoke`, { method: "POST" });
  }

  async updateMemberRole(organizationId: string, actorId: string, role: OrganizationManagementRole): Promise<void> {
    const id = ClerkOrganizationIdSchema.parse(organizationId);
    const actor = ClerkActorIdSchema.parse(actorId);
    await this.sendJson(`${CLERK_API_BASE}/organizations/${encodeURIComponent(id)}/memberships/${encodeURIComponent(actor)}`, "PATCH", {
      role: OrganizationManagementRoleSchema.parse(role),
    });
  }

  async removeMember(organizationId: string, actorId: string): Promise<void> {
    const id = ClerkOrganizationIdSchema.parse(organizationId);
    const actor = ClerkActorIdSchema.parse(actorId);
    await this.send(`${CLERK_API_BASE}/organizations/${encodeURIComponent(id)}/memberships/${encodeURIComponent(actor)}`, { method: "DELETE" });
  }

  async deleteOrganization(organizationId: string): Promise<void> {
    const id = ClerkOrganizationIdSchema.parse(organizationId);
    await this.send(`${CLERK_API_BASE}/organizations/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  private async sendJson(url: string, method: "POST" | "PATCH", body: unknown): Promise<void> {
    await this.send(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  }

  private async send(url: string, init: RequestInit): Promise<void> {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${this.options.secretKey}`);
    headers.set("accept", "application/json");
    const response = await this.fetchImpl(url, {
      ...init,
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      redirect: "error",
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Clerk upstream responded ${response.status}`);
    }
    await response.body?.cancel();
  }

  private async getJson(url: string): Promise<unknown> {
    const response = await this.fetchImpl(url, {
      method: "GET",
      headers: { authorization: `Bearer ${this.options.secretKey}`, accept: "application/json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      redirect: "error",
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Clerk upstream responded ${response.status}`);
    }
    const text = await readBounded(response, MAX_RESPONSE_BYTES);
    return JSON.parse(text) as unknown;
  }
}

async function readBounded(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error("Clerk upstream response exceeds the size limit");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}
