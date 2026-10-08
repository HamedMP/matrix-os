import { MANAGED_INTEGRATIONS, availableManagedActions, planManagedOAuthAction, managedActionCapabilities } from "./managed-oauth-presets.js";
import type { ManagedMcpPresetBroker, GranolaPresetRuntime } from "./granola-preset-broker.js";

interface Runtime extends Omit<GranolaPresetRuntime, "callSelectedTool"> {
  callManagedPresetTool(input: { userId: string; serverId: string; presetId: string; toolName: string; arguments: Record<string, unknown> }): Promise<unknown>;
}
export function createManagedOAuthPresetBroker(deps: {
  broker: Runtime;
  oauth: { start(userId: string, serverId: string, options?: { scopes?: readonly string[] }): Promise<string> };
}): ManagedMcpPresetBroker {
  const preset = (service: unknown) => {
    const id = service && typeof service === "object" ? (service as { id?: unknown }).id : undefined;
    if (typeof id !== "string" || !Object.hasOwn(MANAGED_INTEGRATIONS, id)) throw new Error("Integration unavailable");
    return MANAGED_INTEGRATIONS[id]!;
  };
  const ready = async (userId: string, serviceId: string) => {
    const p = MANAGED_INTEGRATIONS[serviceId];
    if (!p) return null;
    let row = await deps.broker.getPreset(userId, p.id);
    return row;
  };
  return {
    listConnections: async userId => {
      const rows = await Promise.all(Object.values(MANAGED_INTEGRATIONS).map(async p => {
        const row = await ready(userId, p.id);
        return row ? { id: row.id, service: p.id, account_label: p.name, account_email: null, scopes: [...(p.scopes ?? [])], status: row.status === "ready" && availableManagedActions(p.id, row.tools).length ? "active" : row.status === "ready" ? "action_required" : row.status, connected_at: row.created_at, last_used_at: null } : null;
      }));
      return rows.filter((row): row is NonNullable<typeof row> => row !== null);
    },
    listActionCapabilities: async (userId, serviceId) => {
      const row = await ready(userId, serviceId);
      return row?.status === "ready" ? managedActionCapabilities(serviceId, row.tools) : {};
    },
    listAvailableActions: async (userId, serviceId) => {
      if (!MANAGED_INTEGRATIONS[serviceId]) return null;
      const row = await ready(userId, serviceId);
      return row?.status === "ready" ? availableManagedActions(serviceId, row.tools) : [];
    },
    listAvailableActionParams: async (userId, serviceId) => {
      const row = await ready(userId, serviceId);
      if (row?.status !== "ready") return null;
      return managedActionCapabilities(serviceId, row.tools);
    },
    connect: async (userId, service) => {
      const p = preset(service);
      const row = await deps.broker.ensurePreset({ userId, presetId: p.id, name: p.name, url: p.url });
      return { url: await deps.oauth.start(userId, row.id, { scopes: p.scopes }) };
    },
    call: async ({ userId, service, actionId, params, connectionId }) => {
      const p = preset(service); const row = await ready(userId, p.id);
      if (!row || row.status !== "ready" || (connectionId && row.id !== connectionId)) throw new Error("Integration account unavailable");
      const plan = planManagedOAuthAction(p.id, actionId, params, row.tools);
      return deps.broker.callManagedPresetTool({ userId, serverId: row.id, presetId: p.id, ...plan });
    },
    disconnect: async (userId, connectionId) => {
      for (const p of Object.values(MANAGED_INTEGRATIONS)) {
        const row = await deps.broker.getPreset(userId, p.id);
        if (row?.id !== connectionId) continue;
        await deps.broker.remove(userId, connectionId); return true;
      }
      return false;
    },
  };
}
