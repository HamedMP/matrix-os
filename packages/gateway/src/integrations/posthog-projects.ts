import { z } from "zod/v4";
import type { PipedreamConnectClient } from "./pipedream.js";
import type { ServiceAction } from "./types.js";

const MAX_OFFSET = 1_000_000;
const CLOUD_ORIGINS = { us: "https://us.posthog.com", eu: "https://eu.posthog.com" } as const;
const organizationSchema = z.uuid().transform(value => value.toLowerCase());
const paramsSchema = z.strictObject({
  region: z.enum(["us", "eu"]).optional(),
  organizationId: organizationSchema.optional(),
  limit: z.number().int().min(1).max(100).optional(),
  offset: z.number().int().min(0).max(MAX_OFFSET).optional(),
});

function projectRequest(rawParams?: Record<string, unknown>) {
  const params = paramsSchema.safeParse(rawParams ?? {});
  if (!params.success) throw new Error("Invalid action parameters");
  const { region = "us", organizationId, limit = 25, offset = 0 } = params.data;
  const path = organizationId ? `/api/organizations/${organizationId}/projects/` : "/api/projects/";
  return { organizationId, limit, offset, url: `${CLOUD_ORIGINS[region]}${path}`,
    query: { limit: String(limit), offset: String(offset) } };
}

export const POSTHOG_LIST_PROJECTS_ACTION: ServiceAction = {
  description: "List one page of PostHog project metadata (US by default; choose EU for an EU account)",
  risk: "read",
  params: {
    region: { type: "string", description: "us (default) or eu; no automatic cross-region retry" },
    organizationId: { type: "string", description: "Optional organization UUID; otherwise use the account's current organization" },
    limit: { type: "number", minimum: 1, maximum: 100, description: "Page size; default 25" },
    offset: { type: "number", minimum: 0, maximum: MAX_OFFSET, description: "Page offset; default 0" },
  },
  paramsSchema,
  directApi: {
    method: "GET",
    url: params => projectRequest(params).url,
    mapParams: params => projectRequest(params).query,
  },
};

// Allowlist the result fields before they leave the provider boundary. PostHog's
// project serializers also expose api_token and configuration; never return them.
const projectSchema = z.object({
  id: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  name: z.string().min(1).max(200),
  organization: organizationSchema,
});
const pageSchema = z.object({
  results: z.array(projectSchema).max(100),
  count: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  next: z.string().min(1).max(2048).nullable(),
});

/** One same-account read; upstream pagination URLs never become request targets. */
export async function listPostHogProjects(options: {
  pipedream: Pick<PipedreamConnectClient, "proxyGet">;
  externalUserId: string;
  accountId: string;
  params?: Record<string, unknown>;
}): Promise<{ data: unknown }> {
  const { organizationId, limit, offset, url, query } = projectRequest(options.params);
  // The existing Pipedream proxy retains provider credentials and enforces its
  // 10-second abort deadline and zero retries. Callers cannot override URL/headers.
  const result = await options.pipedream.proxyGet({
    externalUserId: options.externalUserId,
    accountId: options.accountId,
    url,
    params: query,
  });
  const page = pageSchema.safeParse(result);
  if (!page.success || page.data.results.length > limit) throw new Error("Integration response unavailable");
  if (organizationId && page.data.results.some(project => project.organization !== organizationId)) {
    throw new Error("Integration response unavailable");
  }
  // Match PostHog's DRF LimitOffsetPagination, including short nonempty pages.
  const nextOffset = page.data.next === null ? null : offset + limit;
  if (nextOffset !== null && (page.data.results.length === 0 || nextOffset > MAX_OFFSET)) {
    throw new Error("Integration response unavailable");
  }
  return { data: {
    results: page.data.results,
    ...(page.data.count !== undefined ? { count: page.data.count } : {}),
    nextOffset,
  } };
}
