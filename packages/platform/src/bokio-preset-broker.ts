import { randomUUID } from "node:crypto";
import type { ManagedMcpPresetBroker } from "./granola-preset-broker.js";
import type { BokioCredentialStore, BokioOAuthManager } from "./bokio-oauth.js";
import { BOKIO_ACTIONS, BOKIO_PRESET, BOKIO_READ_SCOPES, BokioIntegrationError, planBokioRead, requestBokio } from "./bokio-integration.js";

export function createBokioPresetBroker(options: { db: BokioCredentialStore; oauth: BokioOAuthManager; fetcher?: typeof fetch }): ManagedMcpPresetBroker {
  const { db, oauth } = options;
  const matches = (service: unknown) => typeof service === "object" && service !== null && "id" in service && service.id === BOKIO_PRESET.id;
  return {
    listConnections: async (userId) => {
      const row = await db.getCustomMcpPresetForBroker(BOKIO_PRESET.id, userId); if (!row) return [];
      return [{ id: row.id, service: BOKIO_PRESET.id, account_label: BOKIO_PRESET.name, account_email: null, scopes: [...BOKIO_READ_SCOPES], status: row.status === "ready" && oauth.configured ? "active" : row.status === "ready" ? "action_required" : row.status, connected_at: row.created_at, last_used_at: null }];
    },
    listAvailableActions: async (userId, serviceId) => {
      if (serviceId !== BOKIO_PRESET.id) return null;
      const row = await db.getCustomMcpPresetForBroker(BOKIO_PRESET.id, userId);
      return row?.status === "ready" && oauth.configured ? Object.keys(BOKIO_ACTIONS) : [];
    },
    listAvailableActionParams: async (userId, serviceId) => {
      if (serviceId !== BOKIO_PRESET.id) return null;
      const row = await db.getCustomMcpPresetForBroker(BOKIO_PRESET.id, userId);
      return row?.status === "ready" && oauth.configured ? Object.fromEntries(Object.entries(BOKIO_ACTIONS).map(([id, action]) => [id, Object.keys(action.params)])) : null;
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
      planBokioRead(actionId, params, "00000000-0000-0000-0000-000000000000");
      const row = await db.getCustomMcpPresetForBroker(BOKIO_PRESET.id, userId); if (!row) throw new BokioIntegrationError("not_found");
      if (connectionId && row.id !== connectionId) throw new BokioIntegrationError("not_found");
      const authorization = await oauth.resolveAuthorization(userId, row);
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
