/**
 * Clerk Backend API upstream for organization reconciliation (S03 / T016).
 * Bounded pages, bounded response bodies, timeouts on every call, no
 * redirects. Organizations larger than the member cap fail verification
 * rather than being partially projected.
 */
import { z } from "zod/v4";
import type { ClerkOrganizationUpstream } from "./projection.js";
import { ClerkActorIdSchema, ClerkOrganizationIdSchema, normalizeClerkRole, projectAiSubmission } from "./roles.js";

const CLERK_API_BASE = "https://api.clerk.com/v1";
const REQUEST_TIMEOUT_MS = 10_000;
const PAGE_SIZE = 100;
const MAX_MEMBERS = 2_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;

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

export class ClerkOrganizationUpstreamClient implements ClerkOrganizationUpstream {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: { secretKey: string; fetchImpl?: typeof fetch; now?: () => Date }) {
    if (!options.secretKey) throw new Error("Clerk secret key is required");
    this.fetchImpl = options.fetchImpl ?? fetch;
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
