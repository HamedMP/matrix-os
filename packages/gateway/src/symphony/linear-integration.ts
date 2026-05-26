import type { PipedreamConnectClient } from "../integrations/pipedream.js";
import { getAction, getService } from "../integrations/registry.js";
import { executeIntegrationAction } from "../integrations/routes.js";
import type { ConnectedServicesTable, PlatformDb } from "../platform-db.js";
import { parseLinearIntegrationCredential } from "./credential-store.js";
import { defaultLinearGraphqlTransport, type LinearGraphqlRequest, type LinearGraphqlTransport } from "./linear-source.js";

const LINEAR_SERVICE_ID = "linear";
const LINEAR_GRAPHQL_ACTION_ID = "graphql";

function findLinearConnection(connections: ConnectedServicesTable[]): ConnectedServicesTable | undefined {
  return connections.find((connection) => connection.service === LINEAR_SERVICE_ID);
}

export async function hasConnectedLinearIntegration(platformDb: PlatformDb, ownerId: string): Promise<boolean> {
  const connections = await platformDb.listConnectedServices(ownerId);
  return Boolean(findLinearConnection(connections));
}

function integrationProxyHeaders(token: string): Headers {
  return new Headers({
    "Authorization": `Bearer ${token}`,
    "Content-Type": "application/json",
  });
}

function joinIntegrationProxyPath(baseUrl: string, suffix: string): string {
  const url = new URL(baseUrl);
  const basePath = url.pathname.endsWith("/") ? url.pathname.slice(0, -1) : url.pathname;
  url.pathname = `${basePath}${suffix}`;
  return url.toString();
}

export async function hasConnectedLinearIntegrationViaInternalProxy(options: {
  baseUrl: string;
  token: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): Promise<boolean> {
  const fetchImpl = options.fetch ?? fetch;
  const res = await fetchImpl(options.baseUrl, {
    method: "GET",
    headers: integrationProxyHeaders(options.token),
    signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
  });
  if (!res.ok) return false;
  const services: unknown = await res.json();
  if (!Array.isArray(services)) return false;
  return services.some((service) =>
    service &&
    typeof service === "object" &&
    (service as { service?: unknown }).service === LINEAR_SERVICE_ID
  );
}

async function getOrCreateExternalId(platformDb: PlatformDb, ownerId: string): Promise<string> {
  const user = await platformDb.getUserById(ownerId);
  if (user?.pipedream_external_id) return user.pipedream_external_id;
  await platformDb.updatePipedreamExternalId(ownerId, ownerId);
  return ownerId;
}

export function createIntegrationAwareLinearGraphql(options: {
  platformDb: PlatformDb;
  pipedream: PipedreamConnectClient;
}): LinearGraphqlTransport {
  const serviceDefinition = getService(LINEAR_SERVICE_ID);
  const actionDefinition = getAction(LINEAR_SERVICE_ID, LINEAR_GRAPHQL_ACTION_ID);

  return async (request: LinearGraphqlRequest): Promise<unknown> => {
    const ownerId = parseLinearIntegrationCredential(request.credential);
    if (!ownerId) return defaultLinearGraphqlTransport(request);
    if (!serviceDefinition || !actionDefinition) {
      console.error("[symphony] Linear integration registry action is missing");
      throw new Error("linear_integration_unavailable");
    }

    const connections = await options.platformDb.listConnectedServices(ownerId);
    const connection = findLinearConnection(connections);
    if (!connection) throw new Error("linear_integration_unavailable");

    try {
      const externalUserId = await getOrCreateExternalId(options.platformDb, ownerId);
      const result = await executeIntegrationAction({
        pipedream: options.pipedream,
        externalUserId,
        connection,
        def: serviceDefinition,
        actionDef: actionDefinition,
        serviceId: LINEAR_SERVICE_ID,
        actionId: LINEAR_GRAPHQL_ACTION_ID,
        params: {
          query: request.query,
          ...(request.variables ? { variables: request.variables } : {}),
        },
      });
      await options.platformDb.touchServiceUsage(connection.id).catch((err: unknown) => {
        console.warn("[symphony] Linear integration usage touch failed:", err instanceof Error ? err.message : String(err));
      });
      return result.data;
    } catch (err: unknown) {
      console.warn("[symphony] Linear integration GraphQL failed:", err instanceof Error ? err.message : String(err));
      throw new Error("linear_integration_unavailable");
    }
  };
}

export function createInternalProxyLinearGraphql(options: {
  baseUrl: string;
  token: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): LinearGraphqlTransport {
  return async (request: LinearGraphqlRequest): Promise<unknown> => {
    const ownerId = parseLinearIntegrationCredential(request.credential);
    if (!ownerId) return defaultLinearGraphqlTransport(request);

    try {
      const fetchImpl = options.fetch ?? fetch;
      const res = await fetchImpl(joinIntegrationProxyPath(options.baseUrl, "/call"), {
        method: "POST",
        headers: integrationProxyHeaders(options.token),
        body: JSON.stringify({
          service: LINEAR_SERVICE_ID,
          action: LINEAR_GRAPHQL_ACTION_ID,
          params: {
            query: request.query,
            ...(request.variables ? { variables: request.variables } : {}),
          },
        }),
        signal: AbortSignal.timeout(options.timeoutMs ?? request.timeoutMs),
      });
      if (!res.ok) throw new Error("linear_integration_unavailable");
      const body = await res.json() as { data?: unknown };
      return body.data;
    } catch (err: unknown) {
      console.warn("[symphony] Linear integration proxy GraphQL failed:", err instanceof Error ? err.message : String(err));
      throw new Error("linear_integration_unavailable");
    }
  };
}
