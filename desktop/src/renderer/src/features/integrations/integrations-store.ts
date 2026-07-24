// Integrations store: catalog + connected accounts from the gateway proxy
// routes /api/integrations*. Bounded, serializable state only (arrays, caps
// enforced by the parsers). All user-facing error strings go through the
// shared display boundary — upstream provider/platform text never renders.
import { create } from "zustand";
import { AppError, categoryMessage } from "../../../../shared/app-error";
import type { ApiClient } from "../../lib/api";
import { toUserMessage } from "../../lib/errors";
import { useConnection } from "../../stores/connection";
import {
  isValidConnectionId,
  isValidServiceId,
  parseAvailableIntegrations,
  parseConnectedIntegrations,
  parseConnectUrl,
  type AvailableIntegration,
  type ConnectedIntegration,
} from "./types";

const BASE_PATH = "/api/integrations";
const AVAILABLE_PATH = `${BASE_PATH}/available`;
const SYNC_PATH = `${BASE_PATH}/sync`;
const CONNECT_PATH = `${BASE_PATH}/connect`;

export type IntegrationsStatus = "idle" | "loading" | "ready" | "unavailable" | "error";

interface IntegrationsState {
  available: AvailableIntegration[];
  connections: ConnectedIntegration[];
  status: IntegrationsStatus;
  // Generic, display-safe copy (categoryMessage/toUserMessage output only).
  errorMessage: string | null;
  // Loads catalog + connections. A 404 from the proxy is a capability gate:
  // the runtime does not expose integrations, so the store goes "unavailable"
  // instead of "error". Omit the argument to use the active runtime client.
  refresh: (apiOverride?: ApiClient | null) => Promise<void>;
  // Pulls the authoritative account list (POST /sync). Returns success; does
  // not touch errorMessage — callers decide how to surface a failure.
  syncNow: (apiOverride?: ApiClient | null) => Promise<boolean>;
  // Starts the OAuth flow: returns the HTTPS consent URL to open externally,
  // or null after setting a generic errorMessage.
  startConnect: (serviceId: string, apiOverride?: ApiClient | null) => Promise<string | null>;
  // Disconnects one account. On failure the connection stays in the list and
  // errorMessage holds generic copy (partial-failure safe).
  disconnect: (connectionId: string, apiOverride?: ApiClient | null) => Promise<boolean>;
  showError: (message: string) => void;
}

function resolveApi(apiOverride: ApiClient | null | undefined): ApiClient | null {
  if (apiOverride !== undefined) return apiOverride;
  return useConnection.getState().api;
}

function logWarn(scope: string, err: unknown): void {
  console.warn(`[integrations] ${scope}:`, err instanceof Error ? err.message : String(err));
}

export const useIntegrations = create<IntegrationsState>()((set) => ({
  available: [],
  connections: [],
  status: "idle",
  errorMessage: null,

  refresh: async (apiOverride) => {
    const api = resolveApi(apiOverride);
    if (!api) {
      set({
        status: "error",
        errorMessage: categoryMessage("misconfigured"),
        available: [],
        connections: [],
      });
      return;
    }
    set({ status: "loading", errorMessage: null });
    const [availableRes, connectionsRes] = await Promise.allSettled([
      api.get<unknown>(AVAILABLE_PATH),
      api.get<unknown>(BASE_PATH),
    ]);
    if (availableRes.status === "rejected" || connectionsRes.status === "rejected") {
      const err = availableRes.status === "rejected" ? availableRes.reason : (connectionsRes as PromiseRejectedResult).reason;
      if (err instanceof AppError && err.category === "notFound") {
        set({ status: "unavailable", available: [], connections: [], errorMessage: null });
        return;
      }
      logWarn("refresh failed", err);
      set({ status: "error", errorMessage: toUserMessage(err) });
      return;
    }
    set({
      status: "ready",
      available: parseAvailableIntegrations(availableRes.value),
      connections: parseConnectedIntegrations(connectionsRes.value),
      errorMessage: null,
    });
  },

  syncNow: async (apiOverride) => {
    const api = resolveApi(apiOverride);
    if (!api) return false;
    try {
      const raw = await api.post<unknown>(SYNC_PATH, {});
      set({ connections: parseConnectedIntegrations(raw) });
      return true;
    } catch (err: unknown) {
      logWarn("sync failed", err);
      return false;
    }
  },

  startConnect: async (serviceId, apiOverride) => {
    const api = resolveApi(apiOverride);
    if (!isValidServiceId(serviceId)) {
      set({ errorMessage: categoryMessage("server") });
      return null;
    }
    if (!api) {
      set({ errorMessage: categoryMessage("misconfigured") });
      return null;
    }
    try {
      const raw = await api.post<unknown>(CONNECT_PATH, { service: serviceId });
      const url = parseConnectUrl(raw);
      if (!url) {
        logWarn("connect returned no usable https url", new Error("invalid_connect_url"));
        set({ errorMessage: categoryMessage("server") });
        return null;
      }
      set({ errorMessage: null });
      return url;
    } catch (err: unknown) {
      logWarn("connect failed", err);
      set({ errorMessage: toUserMessage(err) });
      return null;
    }
  },

  disconnect: async (connectionId, apiOverride) => {
    const api = resolveApi(apiOverride);
    if (!isValidConnectionId(connectionId)) return false;
    if (!api) {
      set({ errorMessage: categoryMessage("misconfigured") });
      return false;
    }
    try {
      await api.delete(`${BASE_PATH}/${encodeURIComponent(connectionId)}`);
      set((state) => ({
        connections: state.connections.filter((conn) => conn.id !== connectionId),
        errorMessage: null,
      }));
      return true;
    } catch (err: unknown) {
      logWarn("disconnect failed", err);
      set({ errorMessage: toUserMessage(err) });
      return false;
    }
  },

  showError: (message) => {
    set({ errorMessage: message });
  },
}));

// Alias for non-React callers (orchestrator wiring, tests): the same store,
// callable as useIntegrations would be and exposing getState/setState.
export const integrationsStore = useIntegrations;
