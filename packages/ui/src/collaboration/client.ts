import {
  COLLABORATION_HTTP_BODY_LIMIT,
  COLLABORATION_CLIENT_REQUEST_ID_HEADER,
  COLLABORATION_EXPECTED_MEMBER_REVISION_HEADER,
  COLLABORATION_EXPECTED_REVISION_HEADER,
  CollaborationDeleteConditionSchema,
  CollaborationOrganizationIdSchema,
  CollaborationOrganizationMembersCursorSchema,
  ORGANIZATION_LOGO_MAX_BYTES,
} from "@matrix-os/contracts";
import type { CollaborationApi } from "./ChatCollaboratorsDialog.js";

const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

/**
 * Platform REST client for discovery and other scope-free collaboration routes.
 * It carries no realtime streams: scope content and event/terminal sockets go
 * through the direct transport (`direct-api.ts`), because the platform retired
 * its V1 connection tickets and non-direct collaboration sockets.
 */
export function createCollaborationBrowserApi(options: {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  getHeaders?: () => Promise<Record<string, string>>;
}): CollaborationApi {
  const baseUrl = requireBaseUrl(options.baseUrl);
  const request = async (path: string, method: "GET" | "POST" | "PATCH" | "DELETE", body?: unknown) => {
    const url = requirePlatformPath(baseUrl, path, method);
    const isCollaborationRoute = url.pathname.startsWith("/api/collaboration/");
    const deleteConditions = method === "DELETE" && isCollaborationRoute ? CollaborationDeleteConditionSchema.parse(body) : undefined;
    const form = typeof FormData !== "undefined" && body instanceof FormData ? body : undefined;
    if (form && formBytes(form) > ORGANIZATION_LOGO_MAX_BYTES) throw new Error("CollaborationUnavailable");
    const serialized = method === "DELETE" || body === undefined || form ? undefined : JSON.stringify(body);
    if (serialized !== undefined && new TextEncoder().encode(serialized).byteLength > COLLABORATION_HTTP_BODY_LIMIT) {
      throw new Error("CollaborationUnavailable");
    }
    const provided = await options.getHeaders?.();
    const authorization = provided?.Authorization ?? provided?.authorization;
    const headers = new Headers({ accept: "application/json" });
    if (serialized !== undefined) headers.set("content-type", "application/json");
    if (authorization && authorization.length <= 4_096) headers.set("authorization", authorization);
    if (deleteConditions) {
      headers.set(COLLABORATION_CLIENT_REQUEST_ID_HEADER, deleteConditions.clientRequestId);
      headers.set(COLLABORATION_EXPECTED_REVISION_HEADER, deleteConditions.expectedRevision);
      headers.set(COLLABORATION_EXPECTED_MEMBER_REVISION_HEADER, deleteConditions.expectedMemberRevision);
    }
    try {
      const response = await (options.fetchImpl ?? fetch)(url.href, {
        method,
        headers,
        credentials: "same-origin",
        redirect: "error",
        ...(form ? { body: form } : serialized === undefined ? {} : { body: serialized }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!response.ok || !response.headers.get("content-type")?.startsWith("application/json")) {
        await response.body?.cancel();
        throw new Error("CollaborationUnavailable");
      }
      const text = await readBoundedText(response, MAX_RESPONSE_BYTES);
      if (text === null) throw new Error("CollaborationUnavailable");
      return JSON.parse(text) as unknown;
    } catch (error: unknown) {
      if (!(error instanceof Error && error.message === "CollaborationUnavailable")) {
        console.warn("[chat-collaboration] request failed", error instanceof Error ? error.name : "UnknownError");
      }
      throw new Error("CollaborationUnavailable");
    }
  };
  return {
    baseUrl: baseUrl.origin,
    get: (path) => request(path, "GET"),
    post: (path, body) => request(path, "POST", body),
    patch: (path, body) => request(path, "PATCH", body),
    delete: (path, body) => request(path, "DELETE", body),
  };
}

function requireBaseUrl(value: string): URL {
  const url = new URL(value);
  if (!url.hostname || !["https:", "http:"].includes(url.protocol) || url.username || url.password
    || url.pathname !== "/" || url.search || url.hash) throw new Error("CollaborationUnavailable");
  return url;
}

/** The retired V1 ticket route is refused here too, so no caller can revive it through this client. */
const RETIRED_CONNECTION_TICKET_PATH = /\/connection-tickets(?:[/?]|$)/;

function requirePlatformPath(baseUrl: URL, path: string, method: "GET" | "POST" | "PATCH" | "DELETE"): URL {
  if (path.length > 1_024 || path.includes("..") || path.includes("//") || RETIRED_CONNECTION_TICKET_PATH.test(path)) {
    throw new Error("CollaborationUnavailable");
  }
  if (path.startsWith("/api/collaboration/")) {
    const url = new URL(path, baseUrl);
    if (url.origin === baseUrl.origin && url.pathname.startsWith("/api/collaboration/")) return url;
  } else {
    const url = organizationManagementUrl(baseUrl, path, method);
    if (url) return url;
  }
  throw new Error("CollaborationUnavailable");
}

const ORGANIZATION_MEMBERS_PATH = /^\/api\/organizations\/([^/]+)\/members$/;
const ORGANIZATION_INVITATIONS_PATH = /^\/api\/organizations\/([^/]+)\/invitations$/;
const ORGANIZATION_PATH = /^\/api\/organizations\/([^/]+)$/;
const ORGANIZATION_LOGO_PATH = /^\/api\/organizations\/([^/]+)\/logo$/;
const ORGANIZATION_MEMBER_PATH = /^\/api\/organizations\/([^/]+)\/members\/([^/]+)$/;
const ORGANIZATION_INVITATION_PATH = /^\/api\/organizations\/([^/]+)\/invitations\/([^/]+)$/;
const ORGANIZATION_INVITATION_RESEND_PATH = /^\/api\/organizations\/([^/]+)\/invitations\/([^/]+)\/resend$/;
const ACTOR_ID = /^user_[A-Za-z0-9_-]{1,123}$/;
const INVITATION_ID = /^[A-Za-z0-9_:-]{1,128}$/;

/**
 * Organization directory reads made on the platform: the caller's organizations,
 * one page of members, and the admin-only pending invitation list. The URL is
 * rebuilt from validated parts, so nothing else under `/api/organizations` is
 * reachable through this client.
 */
function organizationManagementUrl(baseUrl: URL, path: string, method: "GET" | "POST" | "PATCH" | "DELETE"): URL | null {
  if (!path.startsWith("/api/organizations")) return null;
  const requested = new URL(path, baseUrl);
  if (requested.origin !== baseUrl.origin || requested.hash) return null;
  if (requested.pathname === "/api/organizations") return method === "GET" && !requested.search ? new URL("/api/organizations", baseUrl) : null;
  const exactOrganizationId = ORGANIZATION_PATH.exec(requested.pathname)?.[1];
  if (exactOrganizationId && CollaborationOrganizationIdSchema.safeParse(exactOrganizationId).success
    && !requested.search && (method === "PATCH" || method === "DELETE")) return new URL(requested.pathname, baseUrl);
  const logoOrganizationId = ORGANIZATION_LOGO_PATH.exec(requested.pathname)?.[1];
  if (logoOrganizationId && !requested.search && method === "PATCH" && CollaborationOrganizationIdSchema.safeParse(logoOrganizationId).success) {
    return new URL(requested.pathname, baseUrl);
  }
  const resend = ORGANIZATION_INVITATION_RESEND_PATH.exec(requested.pathname);
  if (resend && !requested.search && method === "POST" && CollaborationOrganizationIdSchema.safeParse(resend[1]).success && INVITATION_ID.test(resend[2]!)) {
    return new URL(requested.pathname, baseUrl);
  }
  const invitation = ORGANIZATION_INVITATION_PATH.exec(requested.pathname);
  if (invitation && !requested.search && method === "DELETE" && CollaborationOrganizationIdSchema.safeParse(invitation[1]).success && INVITATION_ID.test(invitation[2]!)) {
    return new URL(requested.pathname, baseUrl);
  }
  const member = ORGANIZATION_MEMBER_PATH.exec(requested.pathname);
  if (member && !requested.search && (method === "PATCH" || method === "DELETE")
    && CollaborationOrganizationIdSchema.safeParse(member[1]).success && ACTOR_ID.test(member[2]!)) {
    return new URL(requested.pathname, baseUrl);
  }
  const invitationsOrganizationId = ORGANIZATION_INVITATIONS_PATH.exec(requested.pathname)?.[1];
  if (invitationsOrganizationId && CollaborationOrganizationIdSchema.safeParse(invitationsOrganizationId).success) {
    if (!requested.search && (method === "GET" || method === "POST")) return new URL(`/api/organizations/${invitationsOrganizationId}/invitations`, baseUrl);
    return null;
  }
  const organizationId = ORGANIZATION_MEMBERS_PATH.exec(requested.pathname)?.[1];
  if (method !== "GET" || !organizationId || !CollaborationOrganizationIdSchema.safeParse(organizationId).success) return null;
  const url = new URL(`/api/organizations/${organizationId}/members`, baseUrl);
  const keys = [...requested.searchParams.keys()];
  if (keys.length === 0) return url;
  const cursor = CollaborationOrganizationMembersCursorSchema.safeParse(requested.searchParams.get("cursor"));
  if (keys.length !== 1 || keys[0] !== "cursor" || !cursor.success) return null;
  url.searchParams.set("cursor", cursor.data);
  return url;
}

function formBytes(form: FormData): number {
  let size = 0;
  for (const value of form.values()) {
    size += typeof value === "string" ? new TextEncoder().encode(value).byteLength : value.size;
  }
  return size;
}

async function readBoundedText(response: Response, maxBytes: number): Promise<string | null> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    return null;
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(output);
}
