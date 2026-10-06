import { z } from "zod/v4";
import type { ServiceAction } from "./types.js";

// Compile-time Cloud origins only. Never follow caller/provider-supplied next URLs.
const origins = { eu: "https://eu.posthog.com", us: "https://us.posthog.com" } as const;
const scope = { region: z.enum(["eu", "us"]), projectId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) };
const ticketId = z.uuid();
const paging = {
  limit: z.number().int().min(1).max(100).optional(),
  offset: z.number().int().min(0).max(1000000).optional(),
};
const scopeParams = { region: { type: "string", required: true, description: "Cloud region: eu or us" }, projectId: { type: "number", required: true } } as const;
const ticketParams = { ...scopeParams, ticketId: { type: "string", required: true } } as const;
const pageParams = { limit: { type: "number" }, offset: { type: "number" } } as const;

function base(params: Record<string, unknown>): string {
  const region = scope.region.parse(params.region);
  return `${origins[region]}/api/projects/${params.projectId}/conversations/tickets/`;
}
function pageQuery(params: Record<string, unknown>): Record<string, string> {
  return { limit: String(params.limit ?? 50), offset: String(params.offset ?? 0) };
}

// Official Support API (ticket:read), not AI conversation or analytics records.
// LimitOffsetPagination is used by both tickets and messages, per PostHog's
// products/conversations/backend/api/tickets.py. Raw next/count/results remain intact.
export const POSTHOG_SUPPORT_ACTIONS: Record<string, ServiceAction> = {
  list_tickets: {
    description: "List a page of Support tickets (ticket:read); continue using limit/offset, preserving next/count/results",
    risk: "read", params: { ...scopeParams, ...pageParams }, paramsSchema: z.strictObject({ ...scope, ...paging }),
    directApi: { method: "GET", url: base, mapParams: pageQuery },
  },
  get_ticket: {
    description: "Read a selected Support ticket by UUID (ticket:read)",
    risk: "read", params: ticketParams, paramsSchema: z.strictObject({ ...scope, ticketId }),
    directApi: { method: "GET", url: (p) => `${base(p)}${p.ticketId}/` },
  },
  list_ticket_messages: {
    description: "Read a page of Support ticket messages chronologically (ticket:read); continue using limit/offset",
    risk: "read", params: { ...ticketParams, ...pageParams }, paramsSchema: z.strictObject({ ...scope, ticketId, ...paging }),
    directApi: { method: "GET", url: (p) => `${base(p)}${p.ticketId}/messages/`, mapParams: pageQuery },
  },
};
