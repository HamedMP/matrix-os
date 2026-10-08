import type { ServiceAction, ServiceDefinition } from "./types.js";
import type { PipedreamConnectClient } from "./pipedream.js";
import { validateActionParams } from "./parameter-validation.js";
import { BoundedPipedreamReadError } from "./pipedream-bounded-get.js";
import { DriveContentError } from "./drive-content.js";
import { executeCatalogBoundAction } from "./catalog-bound-action.js";

export class IntegrationActionNotImplementedError extends Error {
  readonly serviceId: string;
  readonly actionId: string;

  constructor(serviceId: string, actionId: string) {
    super(
      `Action ${serviceId}/${actionId} is not implemented on this gateway. ` +
      `It has no componentKey (Pipedream Actions API didn't match it) and no directApi block. ` +
      `Add one to packages/gateway/src/integrations/registry.ts.`,
    );
    this.name = "IntegrationActionNotImplementedError";
    this.serviceId = serviceId;
    this.actionId = actionId;
  }
}

/**
 * Runs one registry action for a connected account. signal: the caller's deadline, passed to the provider request so
 * a dropped call stops it (the catalog-bound, Drive content and Gmail reads keep their own deadlines).
 * maxResponseBytes: the call must be a byte-capped raw read (a directApi GET or POST through pipedream.boundedProxy);
 * anything that cannot be capped throws BoundedPipedreamReadError instead of buffering an unbounded response.
 */
export async function executeIntegrationAction(opts: {
  pipedream: PipedreamConnectClient;
  externalUserId: string;
  connection: { pipedream_account_id: string };
  def: ServiceDefinition;
  actionDef: ServiceAction;
  serviceId: string;
  actionId: string;
  params?: Record<string, unknown>;
  signal?: AbortSignal;
  maxResponseBytes?: number;
}): Promise<{ data: unknown; summary?: string }> {
  const { pipedream, externalUserId, connection, def, actionDef, serviceId, actionId, params, signal } = opts;

  if (actionDef.paramsSchema && !validateActionParams(actionDef, params).valid) {
    throw new Error("Invalid action parameters");
  }
  signal?.throwIfAborted();
  const boundCatalog = await executeCatalogBoundAction({ pipedream, externalUserId,
    accountId: connection.pipedream_account_id, serviceId, actionId, params });
  if (boundCatalog) return boundCatalog;
  if (serviceId === "google_drive" && actionId === "read_file") {
    if (!pipedream.readDriveFile) throw new DriveContentError();
    return { data: await pipedream.readDriveFile({ ...params, externalUserId, accountId: connection.pipedream_account_id }) };
  }
  if (serviceId === "gmail" && actionId === "get_attachment") {
    if (!pipedream.boundedGmailGet) throw new BoundedPipedreamReadError();
    return { data: await pipedream.boundedGmailGet({ externalUserId, accountId: connection.pipedream_account_id,
      kind: "attachment", id: String(params?.messageId), attachmentId: String(params?.attachmentId) }) };
  }
  // New thread discovery/ID actions always use a raw capped response, including
  // ordinary callers; a generic SDK parse is not a byte limit.
  if (serviceId === "gmail" && (actionId === "list_threads" || actionId === "get_thread_ids")) {
    if (!pipedream.boundedGmailGet) throw new BoundedPipedreamReadError();
    const identity = { externalUserId, accountId: connection.pipedream_account_id };
    return { data: await pipedream.boundedGmailGet(actionId === "list_threads"
      ? { ...identity, kind: "threads", ...(params?.pageToken !== undefined ? { pageToken: String(params.pageToken) } : {}) }
      : { ...identity, kind: "thread-ids", id: String(params?.threadId) }) };
  }

  if (opts.maxResponseBytes !== undefined) {
    const api = actionDef.directApi;
    if (!pipedream.boundedProxy || !api || (api.method !== "GET" && api.method !== "POST")) {
      throw new BoundedPipedreamReadError();
    }
    return { data: await pipedream.boundedProxy({
      externalUserId, accountId: connection.pipedream_account_id, method: api.method,
      url: typeof api.url === "function" ? api.url(params ?? {}) : api.url,
      ...(api.method === "GET" && api.mapParams ? { params: api.mapParams(params ?? {}) } : {}),
      ...(api.method === "POST" ? { body: api.mapBody ? api.mapBody(params ?? {}) : (params ?? {}) } : {}),
      ...(api.staticHeaders ? { headers: { ...api.staticHeaders } } : {}),
      maxBytes: opts.maxResponseBytes,
    }, signal ?? AbortSignal.timeout(30_000)) };
  }

  // Discovered components have different parameter/cursor contracts.
  // Preserve reviewed direct mappings when both execution paths exist.
  if (actionDef.componentKey && !actionDef.directApi) {
    const safeParams = Object.fromEntries(
      Object.entries(params ?? {}).filter(([k]) => k !== def.pipedreamApp),
    );
    const configuredProps: Record<string, unknown> = {
      ...safeParams,
      [def.pipedreamApp!]: { authProvisionId: connection.pipedream_account_id },
    };
    const result = await pipedream.runAction({
      externalUserId,
      componentKey: actionDef.componentKey,
      configuredProps,
      ...(signal ? { signal } : {}),
    });
    const exports = result.exports as Record<string, unknown> | undefined;
    return {
      data: result.ret,
      summary: typeof exports?.$summary === "string" ? exports.$summary : undefined,
    };
  }

  if (actionDef.directApi) {
    const api = actionDef.directApi;
    const url = typeof api.url === "function" ? api.url(params ?? {}) : api.url;
    const accountId = connection.pipedream_account_id;

    switch (api.method) {
      case "GET":
        return {
          data: await pipedream.proxyGet({
            externalUserId,
            accountId,
            url,
            params: api.mapParams ? api.mapParams(params ?? {}) : undefined,
            ...(api.staticHeaders ? { headers: { ...api.staticHeaders } } : {}),
            ...(signal ? { signal } : {}),
          }),
        };
      case "DELETE":
        return {
          data: await pipedream.proxyDelete({
            externalUserId,
            accountId,
            url,
            params: api.mapParams ? api.mapParams(params ?? {}) : undefined,
            ...(api.staticHeaders ? { headers: { ...api.staticHeaders } } : {}),
            ...(signal ? { signal } : {}),
          }),
        };
      case "POST":
        return {
          data: await pipedream.proxyPost({
            externalUserId,
            accountId,
            url,
            body: api.mapBody ? api.mapBody(params ?? {}) : (params ?? {}),
            ...(api.staticHeaders ? { headers: { ...api.staticHeaders } } : {}),
            ...(signal ? { signal } : {}),
          }),
        };
      case "PUT":
        return {
          data: await pipedream.proxyPut({
            externalUserId,
            accountId,
            url,
            body: api.mapBody ? api.mapBody(params ?? {}) : (params ?? {}),
            ...(api.staticHeaders ? { headers: { ...api.staticHeaders } } : {}),
            ...(signal ? { signal } : {}),
          }),
        };
      case "PATCH":
        return {
          data: await pipedream.proxyPatch({
            externalUserId,
            accountId,
            url,
            body: api.mapBody ? api.mapBody(params ?? {}) : (params ?? {}),
            ...(api.staticHeaders ? { headers: { ...api.staticHeaders } } : {}),
            ...(signal ? { signal } : {}),
          }),
        };
      default: {
        const _exhaustive: never = api.method;
        throw new Error(`Unsupported directApi method: ${String(_exhaustive)}`);
      }
    }
  }

  throw new IntegrationActionNotImplementedError(serviceId, actionId);
}
