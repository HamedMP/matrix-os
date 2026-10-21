import { randomBytes } from "node:crypto";
import { z } from "zod/v4";
import { DRIVE_UPLOAD_ACTION, JIRA_ACTIONS, POSTHOG_ACTIONS } from "./missing-managed-actions.js";
import type { ServiceAction } from "./types.js";

import { createBoundedIntegrationProxy, BoundedIntegrationProxyError as BoundedManagedActionError } from "./bounded-proxy-transport.js";
export { BoundedIntegrationProxyError as BoundedManagedActionError } from "./bounded-proxy-transport.js";

const identity = z.strictObject({ externalUserId: z.string().min(1).max(160).regex(/^[A-Za-z0-9_.:@-]+$/),
  accountId: z.string().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/), serviceId: z.enum(["google_drive", "jira", "posthog"]),
  actionId: z.string().min(1).max(64), params: z.record(z.string(), z.unknown()).optional() });
const resources = z.array(z.object({ id: z.uuid() })).max(100);

const managedActions: Record<string, Record<string, ServiceAction>> = {
  google_drive: { upload_file: DRIVE_UPLOAD_ACTION }, jira: JIRA_ACTIONS, posthog: POSTHOG_ACTIONS,
};
export function isBoundedManagedAction(serviceId: string, actionId: string): boolean {
  return Object.hasOwn(managedActions, serviceId) && Object.hasOwn(managedActions[serviceId], actionId);
}
/** Narrow, raw Pipedream proxy seam for reviewed operations only. The local
 * action catalog owns targets, bodies, HTTP methods and forwarded headers.
 * A single 10s deadline covers token resolution, Jira preflight and body reads;
 * writes are never retried. Account credentials stay inside Pipedream.
 * https://pipedream.com/docs/connect/api-proxy
 */
export function createBoundedManagedAction(options: {
  projectId: string; environment: "development" | "production"; getAccessToken: () => Promise<string>;
  fetcher?: (url: string, init: RequestInit) => Promise<Response>;
}): (input: unknown, callerSignal?: AbortSignal) => Promise<unknown> {
  const proxy = createBoundedIntegrationProxy({ ...options, allowedOrigins: ["https://www.googleapis.com", "https://api.atlassian.com", "https://us.posthog.com", "https://eu.posthog.com"] });
  return async (rawInput, callerSignal) => {
    try {
      const input = identity.parse(rawInput);
      if (!isBoundedManagedAction(input.serviceId, input.actionId)) throw new BoundedManagedActionError();
      const action = managedActions[input.serviceId][input.actionId];
      if (!action?.directApi || !action.paramsSchema) throw new BoundedManagedActionError();
      const params = action.paramsSchema.parse(input.params ?? {}) as Record<string, unknown>;
      const api = action.directApi;
      const signal = callerSignal ? AbortSignal.any([callerSignal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000);
      const request = (url: string, method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", body?: string, contentType?: string) => proxy({
        externalUserId: input.externalUserId, accountId: input.accountId, url, method, ...(body !== undefined ? { body } : {}), ...(contentType ? { contentType } : {}),
      }, signal);
      if (input.serviceId === "jira" && input.actionId !== "list_sites") {
        const sites = resources.parse(await request("https://api.atlassian.com/oauth/token/accessible-resources", "GET"));
        if (!sites.some(site => site.id === params.cloudId)) throw new BoundedManagedActionError();
      }
      let target = typeof api.url === "string" ? api.url : api.url(params);
      const query = api.mapParams?.(params);
      if (query) target += `${target.includes("?") ? "&" : "?"}${new URLSearchParams(query)}`;
      if (input.serviceId === "google_drive") {
        const boundary = `matrix_${randomBytes(24).toString("hex")}`;
        const metadata = JSON.stringify({ name: params.name, ...(params.folderId ? { parents: [params.folderId] } : {}) });
        // Regenerate a boundary would also work, but a collision fails closed.
        if (String(params.content).includes(boundary) || metadata.includes(boundary)) throw new BoundedManagedActionError();
        const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: ${params.mimeType ?? "text/plain"}\r\n\r\n${params.content}\r\n--${boundary}--\r\n`;
        return await request(target, "POST", body, `multipart/related; boundary=${boundary}`);
      }
      const body = api.mapBody ? JSON.stringify(api.mapBody(params)) : undefined;
      return await request(target, api.method, body);
    } catch (error: unknown) {
      console.warn("[integrations] Bounded action failed", { errorName: error instanceof Error ? error.name : "UnknownError" });
      throw new BoundedManagedActionError();
    }
  };
}
