import {
  COLLABORATION_HTTP_BODY_LIMIT,
  COLLABORATION_CLIENT_REQUEST_ID_HEADER,
  COLLABORATION_EXPECTED_MEMBER_REVISION_HEADER,
  COLLABORATION_EXPECTED_REVISION_HEADER,
  CollaborationDeleteConditionSchema,
  CollaborationFailureResponseSchema,
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
/** Stable status and code are safe to classify in shared recipient views. */
export class CollaborationBrowserError extends Error {
  constructor(public readonly status: number, public readonly code?: string) {
    super("CollaborationUnavailable");
    this.name = "CollaborationBrowserError";
  }
}

export function createCollaborationBrowserApi(options: {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  getHeaders?: () => Promise<Record<string, string>>;
}): CollaborationApi {
  const baseUrl = requireBaseUrl(options.baseUrl);
  const request = async (path: string, method: "GET" | "POST" | "PATCH" | "DELETE", body?: unknown) => {
    const url = requireCollaborationPath(baseUrl, path);
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
      if (!response.ok) {
        let code: string | undefined;
        if (response.headers.get("content-type")?.startsWith("application/json")) {
          const text = await readBoundedText(response, 1_024);
          if (text !== null) {
            try {
              const parsed = CollaborationFailureResponseSchema.safeParse(JSON.parse(text) as unknown);
              if (parsed.success) code = parsed.data.code;
            } catch (error: unknown) {
              if (!(error instanceof SyntaxError)) console.warn("[chat-collaboration] failure response rejected", error instanceof Error ? error.name : "UnknownError");
            }
          }
        } else await response.body?.cancel();
        throw new CollaborationBrowserError(response.status, code);
      }
      if (!response.headers.get("content-type")?.startsWith("application/json")) {
        await response.body?.cancel();
        throw new Error("CollaborationUnavailable");
      }
      const text = await readBoundedText(response, MAX_RESPONSE_BYTES);
      if (text === null) throw new Error("CollaborationUnavailable");
      return JSON.parse(text) as unknown;
    } catch (error: unknown) {
      if (error instanceof CollaborationBrowserError) throw error;
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

function requireCollaborationPath(baseUrl: URL, path: string): URL {
  if (path.length > 1_024 || !path.startsWith("/api/collaboration/") || path.includes("..") || path.includes("//")
    || RETIRED_CONNECTION_TICKET_PATH.test(path)) {
    throw new Error("CollaborationUnavailable");
  }
  const url = new URL(path, baseUrl);
  if (url.origin !== baseUrl.origin || !url.pathname.startsWith("/api/collaboration/")) {
    throw new Error("CollaborationUnavailable");
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
