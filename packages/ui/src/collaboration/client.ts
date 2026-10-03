import {
  COLLABORATION_HTTP_BODY_LIMIT,
  COLLABORATION_CLIENT_REQUEST_ID_HEADER,
  COLLABORATION_EXPECTED_MEMBER_REVISION_HEADER,
  COLLABORATION_EXPECTED_REVISION_HEADER,
  CollaborationDeleteConditionSchema,
  CollaborationOrganizationIdSchema,
  CollaborationOrganizationMembersCursorSchema,
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
    const deleteConditions = method === "DELETE" ? CollaborationDeleteConditionSchema.parse(body) : undefined;
    const serialized = method === "DELETE" || body === undefined ? undefined : JSON.stringify(body);
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
        ...(serialized === undefined ? {} : { body: serialized }),
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
  } else if (method === "GET") {
    const url = organizationDirectoryUrl(baseUrl, path);
    if (url) return url;
  }
  throw new Error("CollaborationUnavailable");
}

const ORGANIZATION_MEMBERS_PATH = /^\/api\/organizations\/([^/]+)\/members$/;

/**
 * The two organization directory reads Share and organization drives make on
 * the platform: the caller's organizations and one page of an organization's
 * members. The URL is rebuilt from validated parts, so nothing else under
 * `/api/organizations` is reachable through this client.
 */
function organizationDirectoryUrl(baseUrl: URL, path: string): URL | null {
  if (!path.startsWith("/api/organizations")) return null;
  const requested = new URL(path, baseUrl);
  if (requested.origin !== baseUrl.origin || requested.hash) return null;
  if (requested.pathname === "/api/organizations") return requested.search ? null : new URL("/api/organizations", baseUrl);
  const organizationId = ORGANIZATION_MEMBERS_PATH.exec(requested.pathname)?.[1];
  if (!organizationId || !CollaborationOrganizationIdSchema.safeParse(organizationId).success) return null;
  const url = new URL(`/api/organizations/${organizationId}/members`, baseUrl);
  const keys = [...requested.searchParams.keys()];
  if (keys.some((key) => key !== "include" && key !== "cursor") || new Set(keys).size !== keys.length) return null;
  if (requested.searchParams.has("include")) {
    // Member names and emails for Share: the only optional section the platform offers.
    if (requested.searchParams.get("include") !== "profile") return null;
    url.searchParams.set("include", "profile");
  }
  if (requested.searchParams.has("cursor")) {
    const cursor = CollaborationOrganizationMembersCursorSchema.safeParse(requested.searchParams.get("cursor"));
    if (!cursor.success) return null;
    url.searchParams.set("cursor", cursor.data);
  }
  return url;
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
