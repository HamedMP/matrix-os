import { z } from "zod/v4";

import { buildGatewayRequestUrl, fetchAuthenticatedJson } from "@/lib/requests/http";

const INTEGRATIONS_UNAVAILABLE_ERROR = "Integrations unavailable. Try again.";
const INTEGRATION_REFRESH_ERROR = "Could not refresh connection. Try again.";
const INTEGRATION_DELETE_ERROR = "Could not delete connection. Try again.";
const INTEGRATION_CONNECT_ERROR = "Could not start connection. Try again.";
const INTEGRATION_SYNC_ERROR = "Could not sync connections. Try again.";
export const MOBILE_INTEGRATIONS_REDIRECT_URI = "matrixos://integrations";
const MAX_INTEGRATIONS = 100;
const SERVICE_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const CONNECTION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const IntegrationServiceSchema = z.object({
  id: z.string().regex(SERVICE_ID),
  name: z.string().min(1).max(100),
  category: z.string().min(1).max(64),
  icon: z.string().min(1).max(64),
  logoUrl: z.string().max(2_048).optional(),
});

const AvailableIntegrationsSchema = z.union([
  z.array(IntegrationServiceSchema).max(MAX_INTEGRATIONS),
  z.object({ services: z.array(IntegrationServiceSchema).max(MAX_INTEGRATIONS) })
    .transform((value) => value.services),
]);

const ConnectedIntegrationWireSchema = z.object({
  id: z.string().min(1).max(128),
  service: z.string().regex(SERVICE_ID),
  account_label: z.string().min(1).max(100),
  account_email: z.string().max(320).nullable(),
  status: z.string().min(1).max(32),
  connected_at: z.string().min(1).max(64),
  last_used_at: z.string().max(64).nullable().optional(),
}).transform((value) => ({
  id: value.id,
  service: value.service,
  accountLabel: value.account_label,
  accountEmail: value.account_email,
  status: value.status,
  connectedAt: value.connected_at,
  lastUsedAt: value.last_used_at ?? null,
}));

const ConnectedIntegrationsSchema = z.union([
  z.array(ConnectedIntegrationWireSchema).max(MAX_INTEGRATIONS),
  z.object({ connections: z.array(ConnectedIntegrationWireSchema).max(MAX_INTEGRATIONS) })
    .transform((value) => value.connections),
]);

const RefreshConnectionResponseSchema = z.object({
  id: z.string().regex(CONNECTION_ID),
  service: z.string().regex(SERVICE_ID),
  status: z.literal("active"),
});

const DeleteConnectionResponseSchema = z.object({ ok: z.literal(true) });
const ConnectIntegrationResponseSchema = z.object({
  url: z.string().url().refine(isTrustedPipedreamConnectUrl),
  service: z.string().regex(SERVICE_ID),
});

function isTrustedPipedreamConnectUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && (url.hostname === "pipedream.com" || url.hostname.endsWith(".pipedream.com"));
  } catch {
    return false;
  }
}
const SyncIntegrationsResponseSchema = z.object({
  synced: z.number().int().min(0).max(MAX_INTEGRATIONS),
  services: z.array(ConnectedIntegrationWireSchema).max(MAX_INTEGRATIONS),
});

export type IntegrationService = z.infer<typeof IntegrationServiceSchema>;
export type ConnectedIntegration = z.output<typeof ConnectedIntegrationWireSchema>;

export function fetchAvailableIntegrations(
  clerkToken: string,
  computerGatewayUrl: string,
): Promise<IntegrationService[]> {
  return fetchAuthenticatedJson({
    url: integrationUrl(computerGatewayUrl, "/api/integrations/available"),
    token: clerkToken,
    schema: AvailableIntegrationsSchema,
    errorMessage: INTEGRATIONS_UNAVAILABLE_ERROR,
  });
}

export function fetchConnectedIntegrations(
  clerkToken: string,
  computerGatewayUrl: string,
): Promise<ConnectedIntegration[]> {
  return fetchAuthenticatedJson({
    url: integrationUrl(computerGatewayUrl, "/api/integrations"),
    token: clerkToken,
    schema: ConnectedIntegrationsSchema,
    errorMessage: INTEGRATIONS_UNAVAILABLE_ERROR,
  });
}

export async function refreshIntegrationConnection(
  clerkToken: string,
  computerGatewayUrl: string,
  connectionId: string,
): Promise<void> {
  if (!CONNECTION_ID.test(connectionId)) throw new Error(INTEGRATION_REFRESH_ERROR);
  await fetchAuthenticatedJson({
    url: integrationUrl(
      computerGatewayUrl,
      `/api/integrations/${encodeURIComponent(connectionId)}/refresh`,
    ),
    token: clerkToken,
    schema: RefreshConnectionResponseSchema,
    errorMessage: INTEGRATION_REFRESH_ERROR,
    method: "POST",
  });
}

export async function deleteIntegrationConnection(
  clerkToken: string,
  computerGatewayUrl: string,
  connectionId: string,
): Promise<void> {
  if (!CONNECTION_ID.test(connectionId)) throw new Error(INTEGRATION_DELETE_ERROR);
  await fetchAuthenticatedJson({
    url: integrationUrl(
      computerGatewayUrl,
      `/api/integrations/${encodeURIComponent(connectionId)}`,
    ),
    token: clerkToken,
    schema: DeleteConnectionResponseSchema,
    errorMessage: INTEGRATION_DELETE_ERROR,
    method: "DELETE",
  });
}

export async function createIntegrationConnectUrl(
  clerkToken: string,
  computerGatewayUrl: string,
  serviceId: string,
): Promise<string> {
  if (!SERVICE_ID.test(serviceId)) throw new Error(INTEGRATION_CONNECT_ERROR);
  const response = await fetchAuthenticatedJson({
    url: integrationUrl(computerGatewayUrl, "/api/integrations/connect"),
    token: clerkToken,
    schema: ConnectIntegrationResponseSchema,
    errorMessage: INTEGRATION_CONNECT_ERROR,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      service: serviceId,
      redirectUri: MOBILE_INTEGRATIONS_REDIRECT_URI,
    }),
  });
  return response.url;
}

export async function syncIntegrationConnections(
  clerkToken: string,
  computerGatewayUrl: string,
): Promise<void> {
  await fetchAuthenticatedJson({
    url: integrationUrl(computerGatewayUrl, "/api/integrations/sync"),
    token: clerkToken,
    schema: SyncIntegrationsResponseSchema,
    errorMessage: INTEGRATION_SYNC_ERROR,
    method: "POST",
  });
}

function integrationUrl(computerGatewayUrl: string, path: string): string {
  try {
    return buildGatewayRequestUrl(computerGatewayUrl, path);
  } catch {
    throw new Error(INTEGRATIONS_UNAVAILABLE_ERROR);
  }
}
