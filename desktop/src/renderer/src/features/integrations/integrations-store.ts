// Integrations store: catalog + connected accounts from the gateway proxy
// routes /api/integrations*. Bounded, serializable state only (arrays, caps
// enforced by the parsers). All user-facing error strings go through the
// shared display boundary — upstream provider/platform text never renders.
import { create } from "zustand";
import { AppError, categoryMessage } from "../../../../shared/app-error";
import type { ApiClient } from "../../lib/api";
import { toUserMessage } from "../../lib/errors";
import { useConnection } from "../../stores/connection";
import { captureRuntimeGeneration, isCurrentRuntimeGeneration } from "../../stores/runtime-generation";
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
  // Pulls the authoritative account list (POST /sync). "superseded" means the
  // account/computer changed mid-flight -- not a failure, and callers must not
  // show an error for it. Failures leave errorMessage alone; callers decide.
  syncNow: (apiOverride?: ApiClient | null) => Promise<"ok" | "failed" | "superseded">;
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
  const category = err instanceof AppError
    ? err.category
    : err instanceof Error
      ? err.name
      : "Unknown error";
  console.warn(`[integrations] ${scope}:`, category);
}

// Ordering guard for the catalog load only. Identity ("is this still the same
// account/computer?") is the SHARED runtime generation -- a per-store counter
// cannot express it, because a request that starts after an account change is
// the newest generation and would win while still carrying the old account's
// ApiClient.
let refreshSequence = 0;

export const useIntegrations = create<IntegrationsState>()((set) => ({
  available: [],
  connections: [],
  status: "idle",
  errorMessage: null,

  refresh: async (apiOverride) => {
    const api = resolveApi(apiOverride);
    const runtimeGeneration = captureRuntimeGeneration();
    const sequence = ++refreshSequence;
    const superseded = (): boolean =>
      !isCurrentRuntimeGeneration(runtimeGeneration) || refreshSequence !== sequence;
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
        if (superseded()) return;
        set({ status: "unavailable", available: [], connections: [], errorMessage: null });
        return;
      }
      logWarn("refresh failed", err);
      if (superseded()) return;
      set({ status: "error", errorMessage: toUserMessage(err) });
      return;
    }
    if (superseded()) return;
    set({
      status: "ready",
      available: parseAvailableIntegrations(availableRes.value),
      connections: parseConnectedIntegrations(connectionsRes.value),
      errorMessage: null,
    });
  },

  syncNow: async (apiOverride) => {
    const api = resolveApi(apiOverride);
    if (!api) return "failed";
    // The connect poll holds one ApiClient for ~108s, so identity -- not
    // ordering -- is what matters here: a tick firing after an account change
    // is the newest request but still speaks for the previous account.
    const runtimeGeneration = captureRuntimeGeneration();
    try {
      const raw = await api.post<unknown>(SYNC_PATH, {});
      if (!isCurrentRuntimeGeneration(runtimeGeneration)) return "superseded";
      // Owns the terminal status when it supersedes an in-flight catalog load:
      // that load returns without writing one, so leaving status untouched
      // strands the panel on "loading" with no retry affordance.
      set({ status: "ready", connections: parseConnectedIntegrations(raw), errorMessage: null });
      return "ok";
    } catch (err: unknown) {
      logWarn("sync failed", err);
      if (!isCurrentRuntimeGeneration(runtimeGeneration)) return "superseded";
      // Same reason: never leave a superseded refresh's "loading" in place.
      set((state) => (state.status === "loading"
        ? { status: "error" as const, errorMessage: categoryMessage("server") }
        : {}));
      return "failed";
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
    // Capture, do not bump: the consent URL this returns is opened externally,
    // so returning one minted for the previous account would walk the user
    // through linking a third-party account to a runtime they have left.
    const runtimeGeneration = captureRuntimeGeneration();
    try {
      const raw = await api.post<unknown>(CONNECT_PATH, { service: serviceId });
      if (!isCurrentRuntimeGeneration(runtimeGeneration)) return null;
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
      if (!isCurrentRuntimeGeneration(runtimeGeneration)) return null;
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
    const runtimeGeneration = captureRuntimeGeneration();
    try {
      await api.delete(`${BASE_PATH}/${encodeURIComponent(connectionId)}`);
      // Without this the success path filters the NEW account's connection
      // list by the OLD account's connectionId and clears its error banner.
      if (!isCurrentRuntimeGeneration(runtimeGeneration)) return true;
      set((state) => ({
        connections: state.connections.filter((conn) => conn.id !== connectionId),
        errorMessage: null,
      }));
      return true;
    } catch (err: unknown) {
      logWarn("disconnect failed", err);
      if (!isCurrentRuntimeGeneration(runtimeGeneration)) return false;
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
