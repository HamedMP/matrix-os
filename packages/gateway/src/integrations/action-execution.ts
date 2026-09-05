import type { ServiceAction, ServiceDefinition } from "./types.js";
import type { PipedreamConnectClient } from "./pipedream.js";
import { validateActionParams } from "./action-validation.js";

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

export async function executeIntegrationAction(opts: {
  pipedream: PipedreamConnectClient;
  externalUserId: string;
  connection: { pipedream_account_id: string };
  def: ServiceDefinition;
  actionDef: ServiceAction;
  serviceId: string;
  actionId: string;
  params?: Record<string, unknown>;
}): Promise<{ data: unknown; summary?: string }> {
  const { pipedream, externalUserId, connection, def, actionDef, serviceId, actionId, params } = opts;

  if (actionDef.paramsSchema && !validateActionParams(actionDef, params).valid) {
    throw new Error("Invalid action parameters");
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
