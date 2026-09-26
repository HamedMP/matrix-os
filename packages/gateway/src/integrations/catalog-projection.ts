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
  const eligible = services.filter((service) => readOnly
    ? service.connectorKind === "pipedream"
    : service.connectorKind !== "mcp_preset" || presetBroker);
  return Promise.all(eligible.map(async (service) => {
    let actions = readOnly
      ? Object.fromEntries(Object.entries(service.actions).filter(([, action]) => action.risk === "read"))
      : service.actions;
    if (capabilityIdentityFailed && service.connectorKind === "mcp_preset") {
      actions = {};
    } else if (uid && service.connectorKind === "mcp_preset" && presetBroker?.listAvailableActions) {
      try {
        const availableActions = await presetBroker.listAvailableActions(uid, service.id);
        if (availableActions) {
          actions = Object.fromEntries(
            Object.entries(service.actions).filter(([actionId]) => availableActions.includes(actionId)),
          );
          if (actions.list_notes && presetBroker.listAvailableActionParams) {
            const supported = await presetBroker.listAvailableActionParams(uid, service.id);
            const names = supported?.list_notes ?? [];
            actions = {
              ...actions,
              list_notes: {
                ...actions.list_notes,
                params: Object.fromEntries(
                  Object.entries(actions.list_notes.params).filter(([name]) => names.includes(name)),
                ),
              },
            };
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
