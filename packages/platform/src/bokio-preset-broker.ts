import { randomUUID } from "node:crypto";
import type { ManagedMcpPresetBroker } from "./granola-preset-broker.js";
import type { BokioCredentialStore, BokioOAuthManager } from "./bokio-oauth.js";
import { BOKIO_ACTIONS, BOKIO_PRESET, BokioIntegrationError, planBokioRead, planBokioWrite, requestBokio } from "./bokio-integration.js";
import { BOKIO_ACTION_SCOPES } from "@matrix-os/contracts/bokio-integration";

export function createBokioPresetBroker(options: { db: BokioCredentialStore; oauth: BokioOAuthManager; fetcher?: typeof fetch }): ManagedMcpPresetBroker {
  const { db, oauth } = options;
  const matches = (service: unknown) => typeof service === "object" && service !== null && "id" in service && service.id === BOKIO_PRESET.id;
  const readGrant = async (userId: string, row: Awaited<ReturnType<BokioCredentialStore["getCustomMcpPresetForBroker"]>>) => {
    if (row?.status !== "ready" || !oauth.configured) return { scopes: [] as string[], actionRequired: row?.status === "ready" };
    try {
      return { scopes: await oauth.grantedScopes(userId, row), actionRequired: false };
    } catch (error: unknown) {
      if (!(error instanceof BokioIntegrationError) || error.code !== "action_required") throw error;
      console.warn("[bokio] connection requires authorization");
      return { scopes: [] as string[], actionRequired: true };
    }
  };
  const available = async (userId: string, row: Awaited<ReturnType<BokioCredentialStore["getCustomMcpPresetForBroker"]>>) => {
    const { scopes } = await readGrant(userId, row);
    return Object.keys(BOKIO_ACTIONS).filter(id => scopes.includes(BOKIO_ACTION_SCOPES[id]));
  };
  return {
    listConnections: async (userId) => {
      const row = await db.getCustomMcpPresetForBroker(BOKIO_PRESET.id, userId); if (!row) return [];
      const { scopes, actionRequired } = await readGrant(userId, row);
      return [{ id: row.id, service: BOKIO_PRESET.id, account_label: BOKIO_PRESET.name, account_email: null, scopes,
        status: row.status === "ready" ? actionRequired ? "action_required" : "active" : row.status,
        connected_at: row.created_at, last_used_at: null }];
    },
    listAvailableActions: async (userId, serviceId) => {
      if (serviceId !== BOKIO_PRESET.id) return null;
      const row = await db.getCustomMcpPresetForBroker(BOKIO_PRESET.id, userId);
      return available(userId, row);
    },
    listAvailableActionParams: async (userId, serviceId) => {
      if (serviceId !== BOKIO_PRESET.id) return null;
      const row = await db.getCustomMcpPresetForBroker(BOKIO_PRESET.id, userId);
      const actions = await available(userId, row);
      return row?.status === "ready" && oauth.configured ? Object.fromEntries(actions.map(id => [id, Object.keys(BOKIO_ACTIONS[id].params)])) : null;
    },
    connect: async (userId, service) => {
      if (!matches(service)) throw new BokioIntegrationError("invalid");
      if (!oauth.configured) throw new BokioIntegrationError("action_required");
      let row = await db.getCustomMcpPresetForBroker(BOKIO_PRESET.id, userId);
      if (!row) {
        try { await db.createCustomMcpServer({ id: randomUUID(), userId, presetId: BOKIO_PRESET.id, name: BOKIO_PRESET.name, url: BOKIO_PRESET.url, authMode: "oauth", pendingExpiresAt: new Date(Date.now() + 10 * 60 * 1000) }); }
        catch (error: unknown) {
          // The owner's unique preset index is the singleton authority. Other
          // database failures must propagate rather than looking like not found.
          if (!error || typeof error !== "object" || !("code" in error) || error.code !== "23505") throw error;
        }
        row = await db.getCustomMcpPresetForBroker(BOKIO_PRESET.id, userId);
      }
      if (!row) throw new BokioIntegrationError("not_found");
      return { url: await oauth.start(userId, row.id) };
    },
    call: async ({ userId, service, actionId, params, connectionId }) => {
      if (!matches(service)) throw new BokioIntegrationError("invalid");
      // Validate arguments before resolving/refreshing any credential.
      if (!Object.hasOwn(BOKIO_ACTIONS, actionId)) throw new BokioIntegrationError("invalid");
      const write = BOKIO_ACTIONS[actionId].risk === "write";
      const planAction = write ? planBokioWrite : planBokioRead;
      planAction(actionId, params, "00000000-0000-0000-0000-000000000000");
      const row = await db.getCustomMcpPresetForBroker(BOKIO_PRESET.id, userId); if (!row) throw new BokioIntegrationError("not_found");
      if (connectionId && row.id !== connectionId) throw new BokioIntegrationError("not_found");
      if (!(await oauth.grantedScopes(userId, row)).includes(BOKIO_ACTION_SCOPES[actionId])) throw new BokioIntegrationError("action_required");
      const authorization = await oauth.resolveAuthorization(userId, row);
      // Refresh can narrow authority. Check the latest encrypted grant before a write.
      if (!(await oauth.grantedScopes(userId, row)).includes(BOKIO_ACTION_SCOPES[actionId])) throw new BokioIntegrationError("action_required");
      if (write) {
        const plan = planBokioWrite(actionId, params, authorization.companyId);
        return requestBokio({ url: plan.url, method: "POST", headers: { Authorization: authorization.authorization, "Content-Type": "application/json" }, body: plan.body, maxBytes: 1024 * 1024, fetcher: options.fetcher });
      }
      const plan = planBokioRead(actionId, params, authorization.companyId);
      return requestBokio({ url: plan.url, method: "GET", headers: { Authorization: authorization.authorization }, maxBytes: 1024 * 1024, fetcher: options.fetcher });
    },
    disconnect: async (userId, connectionId) => {
      const row = await db.getCustomMcpPresetForBroker(BOKIO_PRESET.id, userId);
      if (!row || row.id !== connectionId) return false;
      await oauth.disconnect(userId, row);
      return true;
    },
  };
}
