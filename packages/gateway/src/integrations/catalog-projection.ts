import type { Context } from "hono";
import { MATRIX_MCP_RUN_CONTEXT_KEY } from "../chat/matrix-mcp-launch.js";
import type { ServiceDefinition } from "./types.js";
import { INTEGRATION_READ_SCOPE_HEADER } from "./scope-provenance.js";

export function isScopedReadCatalogRequest(c: Context): boolean {
  const runContext = c.get(MATRIX_MCP_RUN_CONTEXT_KEY as never) as { scope?: string } | undefined;
  return runContext?.scope === "integration_read"
    || c.req.header(INTEGRATION_READ_SCOPE_HEADER) === "read";
}

interface CatalogPresetBroker {
  listActionCapabilities?(userId: string, serviceId: string): Promise<Record<string, readonly string[]> | null>;
  listAvailableActions?(userId: string, serviceId: string): Promise<readonly string[] | null>;
  listAvailableActionParams?(userId: string, serviceId: string): Promise<Record<string, readonly string[]> | null>;
}

/** Resolve advertised actions without expanding a scoped read bearer into preset or write authority. */
export async function projectIntegrationCatalog(options: {
  services: readonly ServiceDefinition[];
  uid: string | null;
  capabilityIdentityFailed: boolean;
  authoritative: boolean;
  readOnly: boolean;
  presetBroker?: CatalogPresetBroker;
  logoUrl(service: ServiceDefinition): string;
}): Promise<ServiceDefinition[]> {
  const { services, uid, capabilityIdentityFailed, authoritative, readOnly, presetBroker, logoUrl } = options;
  const managed = (service: ServiceDefinition) => service.connectorKind === "mcp_preset" || service.connectorKind === "managed_oauth";
  const eligible = services.filter(service => !managed(service) || Boolean(presetBroker));
  return Promise.all(eligible.map(async (service) => {
    let actions = readOnly
      ? Object.fromEntries(Object.entries(service.actions).filter(([, action]) => action.risk === "read"))
      : service.actions;
    if (capabilityIdentityFailed && managed(service)) {
      actions = {};
    } else if (uid && managed(service) && presetBroker?.listAvailableActions) {
      try {
        const capabilities = await presetBroker.listActionCapabilities?.(uid, service.id);
        const availableActions = capabilities ? Object.keys(capabilities) : await presetBroker.listAvailableActions(uid, service.id);
        if (availableActions) {
          actions = Object.fromEntries(
            Object.entries(service.actions).filter(([actionId]) => availableActions.includes(actionId)),
          );
          if (presetBroker.listAvailableActionParams) {
            const supported = capabilities ?? await presetBroker.listAvailableActionParams(uid, service.id);
            if (supported) actions = Object.fromEntries(Object.entries(actions).map(([id, action]) => [id, {
              ...action, params: Object.hasOwn(supported, id) ? Object.fromEntries(Object.entries(action.params).filter(([name]) => supported[id]?.includes(name))) : action.params,
            }]));
          }
        } else if (authoritative) {
          actions = {};
        }
      } catch (err: unknown) {
        console.warn(
          `[integrations] ${service.id} capability projection failed:`,
          err instanceof Error ? err.message : String(err),
        );
        actions = {};
      }
    }
    return { ...service, actions, logoUrl: logoUrl(service) };
  }));
}
