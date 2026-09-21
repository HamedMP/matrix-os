/**
 * `CollaborationApi` over the direct transport (S06 / T031, T032).
 *
 * Scope and invitation routes go to the resource's home through
 * `CollaborationDirectClient`; discovery stays a platform metadata
 * projection and every item's content is hydrated from its home here, so
 * the platform never fetches resource data. Anything else (owner-side scope
 * creation and preflight on the owner's own runtime) keeps the existing
 * platform path until S18 retires it.
 */
import { CollaborationDeleteConditionSchema, CollaborationDiscoveryResponseSchema, CollaborationIdSchema } from "@matrix-os/contracts";
import type { CollaborationApi } from "./ChatCollaboratorsDialog.js";
import { createCollaborationBrowserApi } from "./client.js";
import { CollaborationDirectError, createCollaborationDirectClient, type CollaborationDirectClient, type CollaborationDirectClientOptions } from "./direct-client.js";

const MAX_HYDRATION_CONCURRENCY = 4;
const MAX_REMEMBERED_INVITATIONS = 500;
const SCOPE_PATH = /^\/api\/collaboration\/scopes\/([0-9a-f-]{36})(?:[/?]|$)/;
const INVITATION_PATH = /^\/api\/collaboration\/invitations\/([0-9a-f-]{36})(?:[/?]|$)/;
const DISCOVERY_PATH = /^\/api\/collaboration\/(inbox|shared)(?:\?|$)/;
const OWNER_RUNTIME_SETUP_PATH = /^\/api\/collaboration\/runtimes\/([^/?]+)\/(?:catalog\/resolve|scopes(?:\/preflight)?)$/;

export interface CollaborationDirectApi extends CollaborationApi {
  direct: CollaborationDirectClient;
  /** Associates an invitation with the scope whose home serves it (discovery does this automatically). */
  rememberInvitation(invitationId: string, scopeId: string): void;
}

export function createCollaborationDirectApi(options: CollaborationDirectClientOptions): CollaborationDirectApi {
  const direct = createCollaborationDirectClient(options);
  const platform = createCollaborationBrowserApi({
    baseUrl: options.platformBaseUrl,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.getHeaders ? { getHeaders: options.getHeaders } : {}),
  });
  const invitations = new Map<string, string>();
  const rememberInvitation = (invitationId: string, scopeId: string) => {
    if (invitations.size >= MAX_REMEMBERED_INVITATIONS) {
      const oldest = invitations.keys().next().value;
      if (oldest !== undefined) invitations.delete(oldest);
    }
    invitations.set(CollaborationIdSchema.parse(invitationId), CollaborationIdSchema.parse(scopeId));
  };

  const scopeFor = (path: string): string | null => {
    const scope = SCOPE_PATH.exec(path);
    if (scope) return scope[1]!;
    const invitation = INVITATION_PATH.exec(path);
    if (invitation) return invitations.get(invitation[1]!) ?? null;
    return null;
  };

  const hydrate = async (item: Record<string, unknown>): Promise<Record<string, unknown>> => {
    if (item.resource !== undefined) return item;
    const scopeId = typeof item.scopeId === "string" ? item.scopeId : null;
    if (!scopeId) return item;
    try {
      if (item.status === "invited" && typeof item.invitationId === "string") {
        rememberInvitation(item.invitationId, scopeId);
        return { ...item, resource: await direct.request(scopeId, "GET", `/api/collaboration/invitations/${item.invitationId}`) };
      }
      if (item.status === "accepted") {
        const base = `/api/collaboration/scopes/${scopeId}`;
        const [scope, content] = await Promise.all([
          direct.request(scopeId, "GET", base),
          direct.request(scopeId, "GET", `${base}/${item.kind === "terminal" ? "terminal" : item.kind === "project" ? "project" : "chat"}`),
        ]);
        return { ...item, resource: { scope, [item.kind === "terminal" ? "terminal" : item.kind === "project" ? "project" : "chat"]: content } };
      }
      return item;
    } catch (error: unknown) {
      const code = error instanceof CollaborationDirectError ? error.code : "unavailable";
      if (!(error instanceof CollaborationDirectError)) console.warn("[collaboration-direct] hydration failed", error instanceof Error ? error.name : "UnknownError");
      return { ...item, home: code === "host_offline" || code === "unavailable" ? "offline" : "denied" };
    }
  };

  const discovery = async (path: string): Promise<unknown> => {
    const page = CollaborationDiscoveryResponseSchema.parse(await platform.get(path));
    const items = await mapLimited(page.items as Array<Record<string, unknown>>, MAX_HYDRATION_CONCURRENCY, hydrate);
    return { ...page, items };
  };

  const send = async (method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<unknown> => {
    if (DISCOVERY_PATH.test(path) && method === "GET") return discovery(path);
    const ownerRuntime = method === "POST" ? OWNER_RUNTIME_SETUP_PATH.exec(path) : null;
    if (ownerRuntime) {
      let runtimeId: string;
      try { runtimeId = decodeURIComponent(ownerRuntime[1]!); }
      catch (error: unknown) {
        if (!(error instanceof URIError)) console.warn("[collaboration-direct] runtime identifier rejected", error instanceof Error ? error.name : "UnknownError");
        throw new Error("CollaborationUnavailable");
      }
      const organizationId = body && typeof body === "object" ? (body as { organizationId?: unknown }).organizationId : null;
      if (typeof organizationId !== "string") throw new Error("CollaborationUnavailable");
      try { return await direct.requestOwnerRuntime(runtimeId, organizationId, path, body); }
      catch (error: unknown) {
        if (error instanceof CollaborationDirectError) throw new Error("CollaborationUnavailable", { cause: error });
        throw error;
      }
    }
    const scopeId = scopeFor(path);
    if (!scopeId) {
      if (INVITATION_PATH.test(path)) throw new Error("CollaborationUnavailable");
      return method === "GET" ? platform.get(path) : method === "POST" ? platform.post(path, body) : method === "PATCH" ? platform.patch!(path, body) : platform.delete(path, body);
    }
    try {
      if (method === "DELETE") return await direct.request(scopeId, "DELETE", path, undefined, CollaborationDeleteConditionSchema.parse(body));
      return await direct.request(scopeId, method, path, body);
    } catch (error: unknown) {
      if (error instanceof CollaborationDirectError) throw new Error("CollaborationUnavailable", { cause: error });
      throw error;
    }
  };

  return {
    baseUrl: platform.baseUrl,
    direct,
    rememberInvitation,
    get: (path) => send("GET", path),
    post: (path, body) => send("POST", path, body),
    patch: (path, body) => send("PATCH", path, body),
    delete: (path, body) => send("DELETE", path, body),
    subscribe: (scopeId, onEvent, onUnavailable, onConnectionChange) => direct.subscribeEvents(scopeId, {
      onEvent, onUnavailable, ...(onConnectionChange ? { onConnectionChange } : {}),
    }),
    subscribeTerminal: (scopeId, handlers) => direct.subscribeTerminal(scopeId, handlers),
  };
}

async function mapLimited<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}
