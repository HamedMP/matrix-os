import {
  COLLABORATION_CLIENT_REQUEST_ID_HEADER,
  COLLABORATION_EXPECTED_MEMBER_REVISION_HEADER,
  COLLABORATION_EXPECTED_REVISION_HEADER,
  COLLABORATION_HTTP_BODY_LIMIT,
  CollaborationDeleteConditionSchema,
} from "@matrix-os/contracts";
import type { CollaborationProofSigner } from "./proof.js";
import type { PlatformCollaborationRepository } from "./repository.js";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const ACTOR = "[A-Za-z0-9_-]{1,128}";
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const PROOF_HEADER = "x-matrix-collaboration-proof";
const RUNTIME = "[A-Za-z0-9:_-]{1,128}";

const RUNTIME_ROUTES = [
  ["POST", new RegExp(`^/api/collaboration/runtimes/(${RUNTIME})/scopes/preflight$`)],
  ["POST", new RegExp(`^/api/collaboration/runtimes/(${RUNTIME})/scopes$`)],
] as const;

const SCOPE_ROUTES = [
  ["GET", new RegExp(`^/api/collaboration/scopes/(${UUID})$`)],
  ["GET", new RegExp(`^/api/collaboration/scopes/(${UUID})/members$`)],
  ["POST", new RegExp(`^/api/collaboration/scopes/(${UUID})/invitations$`)],
  ["DELETE", new RegExp(`^/api/collaboration/scopes/(${UUID})/invitations/${UUID}$`)],
  ["PATCH", new RegExp(`^/api/collaboration/scopes/(${UUID})/members/${ACTOR}$`)],
  ["DELETE", new RegExp(`^/api/collaboration/scopes/(${UUID})/members/${ACTOR}$`)],
  ["GET", new RegExp(`^/api/collaboration/scopes/(${UUID})/user-state$`)],
  ["PATCH", new RegExp(`^/api/collaboration/scopes/(${UUID})/user-state$`)],
  ["GET", new RegExp(`^/api/collaboration/scopes/(${UUID})/chat$`)],
  ["GET", new RegExp(`^/api/collaboration/scopes/(${UUID})/chat/messages$`)],
  ["POST", new RegExp(`^/api/collaboration/scopes/(${UUID})/chat/messages$`)],
] as const;

const INVITATION_ROUTES = [
  ["GET", new RegExp(`^/api/collaboration/invitations/(${UUID})$`)],
  ["POST", new RegExp(`^/api/collaboration/invitations/(${UUID})/accept$`)],
] as const;

export interface ParsedCollaborationProxyRoute {
  kind: "runtime" | "scope" | "invitation";
  identifier: string;
}

export function parseCollaborationProxyRoute(
  method: string,
  path: string,
): ParsedCollaborationProxyRoute | null {
  for (const [allowedMethod, pattern] of RUNTIME_ROUTES) {
    if (method !== allowedMethod) continue;
    const match = pattern.exec(path);
    if (match) return { kind: "runtime", identifier: match[1]! };
  }
  for (const [allowedMethod, pattern] of SCOPE_ROUTES) {
    if (method !== allowedMethod) continue;
    const match = pattern.exec(path);
    if (match) return { kind: "scope", identifier: match[1]! };
  }
  for (const [allowedMethod, pattern] of INVITATION_ROUTES) {
    if (method !== allowedMethod) continue;
    const match = pattern.exec(path);
    if (match) return { kind: "invitation", identifier: match[1]! };
  }
  return null;
}

export interface CollaborationRuntimeRoute {
  runtimeId: string;
  ownerId: string;
  baseUrl: string;
}

export class CollaborationProxy {
  constructor(private readonly options: {
    repository: PlatformCollaborationRepository;
    signer: CollaborationProofSigner;
    resolveRuntime(runtimeId: string): Promise<CollaborationRuntimeRoute | null>;
    fetchImpl?: typeof fetch;
  }) {}

  async forward(input: {
    actorId: string;
    method: string;
    path: string;
    query: string;
    body: Uint8Array;
    headers: Headers;
  }): Promise<Response> {
    const route = parseCollaborationProxyRoute(input.method, input.path);
    if (!route) return safeResponse("Collaboration route not found", 404);
    if (input.body.byteLength > COLLABORATION_HTTP_BODY_LIMIT) {
      return safeResponse("Collaboration request too large", 413);
    }
    const conditionalHeaders = input.method === "DELETE" ? CollaborationDeleteConditionSchema.safeParse({
      clientRequestId: input.headers.get(COLLABORATION_CLIENT_REQUEST_ID_HEADER),
      expectedRevision: input.headers.get(COLLABORATION_EXPECTED_REVISION_HEADER),
      expectedMemberRevision: input.headers.get(COLLABORATION_EXPECTED_MEMBER_REVISION_HEADER),
    }) : undefined;
    if (input.method === "DELETE" && (input.body.byteLength !== 0 || !conditionalHeaders?.success)) {
      return safeResponse("Invalid collaboration request", 422);
    }
    try {
      const directory = route.kind === "scope"
        ? await this.options.repository.getDirectoryRoute(route.identifier)
        : route.kind === "invitation"
          ? await this.options.repository.getInvitationRoute(input.actorId, route.identifier)
          : null;
      let runtime = route.kind === "runtime"
        ? await this.options.resolveRuntime(route.identifier)
        : null;
      if (route.kind === "runtime" && (!runtime || runtime.ownerId !== input.actorId)) {
        return safeResponse("Collaboration route not found", 404);
      }
      if (route.kind !== "runtime" && !directory) return safeResponse("Collaboration route not found", 404);
      const ownerId = runtime?.ownerId ?? directory!.ownerId;
      const scopeId = directory?.scopeId;
      const policy = await this.options.repository.getPolicy("m1");
      const participants = scopeId
        ? await this.options.repository.listScopeActors(scopeId)
        : [input.actorId];
      if (!policyAllows(policy, input.actorId, ownerId, participants, input.method)) {
        return safeResponse("Collaboration unavailable", policy.mode === "read_only" ? 403 : 404);
      }
      runtime ??= await this.options.resolveRuntime(directory!.runtimeId);
      if (!runtime || (directory && (runtime.runtimeId !== directory.runtimeId || runtime.ownerId !== directory.ownerId))) {
        return safeResponse("Collaboration unavailable", 503);
      }
      const baseUrl = parseRuntimeBaseUrl(runtime.baseUrl);
      if (!baseUrl) return safeResponse("Collaboration unavailable", 503);

      const signedProof = this.options.signer.signHttp({
        actorId: input.actorId,
        ownerId,
        runtimeId: runtime.runtimeId,
        ...(scopeId ? { scopeId } : {}),
        method: input.method as "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
        path: input.path,
        query: input.query,
        body: input.body,
        ...(conditionalHeaders?.success ? { conditionalHeaders: conditionalHeaders.data } : {}),
      });
      const headers = new Headers();
      const contentType = input.headers.get("content-type");
      if (contentType && contentType.length <= 128) headers.set("content-type", contentType);
      if (conditionalHeaders?.success) {
        headers.set(COLLABORATION_CLIENT_REQUEST_ID_HEADER, conditionalHeaders.data.clientRequestId);
        headers.set(COLLABORATION_EXPECTED_REVISION_HEADER, conditionalHeaders.data.expectedRevision);
        headers.set(COLLABORATION_EXPECTED_MEMBER_REVISION_HEADER, conditionalHeaders.data.expectedMemberRevision);
      }
      headers.set("accept", "application/json");
      headers.set(PROOF_HEADER, Buffer.from(JSON.stringify(signedProof)).toString("base64url"));
      const response = await (this.options.fetchImpl ?? fetch)(
        `${baseUrl.origin}${input.path}${input.query ? `?${input.query}` : ""}`,
        {
          method: input.method,
          headers,
          body: input.body.byteLength === 0 ? undefined : Uint8Array.from(input.body).buffer,
          redirect: "error",
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (!response.ok) {
        await response.body?.cancel();
        return safeResponse(
          response.status === 401 || response.status === 403
            ? "Collaboration request denied"
            : response.status === 404
              ? "Collaboration route not found"
              : response.status === 409
                ? "Collaboration state changed"
                : "Collaboration unavailable",
          safeStatus(response.status),
        );
      }
      const bytes = await readBounded(response, MAX_RESPONSE_BYTES);
      if (!bytes) return safeResponse("Collaboration unavailable", 503);
      return new Response(Uint8Array.from(bytes).buffer, {
        status: response.status,
        headers: {
          "cache-control": "private, no-store",
          "content-type": safeContentType(response.headers.get("content-type")),
        },
      });
    } catch (error: unknown) {
      console.warn("[collaboration-proxy] upstream unavailable", error instanceof Error ? error.name : "UnknownError");
      return safeResponse("Collaboration unavailable", 503);
    }
  }
}

function policyAllows(
  policy: { mode: "off" | "internal" | "enabled" | "read_only"; cohort: string[] },
  actorId: string,
  ownerId: string,
  participants: string[],
  method: string,
): boolean {
  if (policy.mode === "off") return false;
  if (policy.mode === "read_only") return method === "GET";
  if (policy.mode === "enabled") return true;
  const cohort = new Set(policy.cohort);
  return cohort.has(actorId) && cohort.has(ownerId) && participants.every((actor) => cohort.has(actor));
}

function parseRuntimeBaseUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    if (!url.hostname || !["http:", "https:"].includes(url.protocol)
      || url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
    return url;
  } catch (error: unknown) {
    console.warn("[collaboration-proxy] invalid registered runtime URL", error instanceof Error ? error.name : "UnknownError");
    return null;
  }
}

async function readBounded(response: Response, maxBytes: number): Promise<Uint8Array | null> {
  if (!response.body) return new Uint8Array();
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
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function safeContentType(value: string | null): string {
  return value?.startsWith("application/json") ? "application/json" : "application/octet-stream";
}

function safeStatus(status: number): 401 | 403 | 404 | 409 | 413 | 422 | 429 | 503 {
  return [401, 403, 404, 409, 413, 422, 429].includes(status)
    ? status as 401 | 403 | 404 | 409 | 413 | 422 | 429
    : 503;
}

function safeResponse(message: string, status: 401 | 403 | 404 | 409 | 413 | 422 | 429 | 503): Response {
  return new Response(message, {
    status,
    headers: { "cache-control": "private, no-store", "content-type": "text/plain; charset=utf-8" },
  });
}
