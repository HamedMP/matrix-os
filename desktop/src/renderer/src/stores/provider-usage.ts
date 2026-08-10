import {
  ProviderUsageResponseSchema,
  type ProviderUsageResponse,
  type ProviderUsageSourceSummary,
  type ProviderUsageWindow,
  type RuntimeSummary,
} from "@matrix-os/contracts";
import { create } from "zustand";
import { invoke } from "../lib/operator";
import { captureRuntimeGeneration, isCurrentRuntimeGeneration } from "./runtime-generation";

const PROVIDER_USAGE_MAX_AGE_MS = 60_000;
const PROVIDER_USAGE_ERROR = "Provider usage is temporarily unavailable.";

export type ProviderUsageStatus = "idle" | "loading" | "ready" | "refreshing" | "error";

export interface ProviderUsageState {
  status: ProviderUsageStatus;
  response: ProviderUsageResponse | null;
  runtimeScope: string | null;
  error: string | null;
  ensureRuntimeScope(scope: string): void;
  refresh(options?: { force?: boolean }): Promise<void>;
  clear(): void;
}

interface InFlightRefresh {
  scope: string;
  sequence: number;
  promise: Promise<void>;
}

let requestSequence = 0;
let inFlight: InFlightRefresh | null = null;

function sourceForProvider(
  response: ProviderUsageResponse,
  providerId: string,
): ProviderUsageSourceSummary | null {
  const matches = response.usageSources.filter((source) =>
    source.linkedAgentProviderIds.includes(providerId)
  );
  return matches.length === 1 ? matches[0]! : null;
}

export function selectUsageSource(
  response: ProviderUsageResponse | null,
  summary: RuntimeSummary | null,
  activeThreadId: string | null,
  defaultProviderId: string | null,
): ProviderUsageSourceSummary | null {
  if (!response || !summary) return null;

  if (activeThreadId) {
    const activeThread = [
      ...summary.activeThreads.items,
      ...summary.attentionThreads.items,
    ].find((thread) => thread.id === activeThreadId);
    if (activeThread) return sourceForProvider(response, activeThread.providerId);
  }

  if (defaultProviderId) return sourceForProvider(response, defaultProviderId);

  const firstReadyProvider = summary.providers.find((provider) =>
    provider.availability === "available"
    && provider.installStatus === "installed"
    && provider.authStatus === "authenticated"
  );
  return firstReadyProvider
    ? sourceForProvider(response, firstReadyProvider.id)
    : null;
}

export function lowestRemainingWindow(
  source: ProviderUsageSourceSummary | null,
): ProviderUsageWindow | null {
  if (!source || (source.state !== "available" && source.state !== "stale")) return null;
  let lowest: ProviderUsageWindow | null = null;
  for (const window of source.windows) {
    if (!lowest || window.remainingPercent < lowest.remainingPercent) lowest = window;
  }
  return lowest;
}

function responseIsFresh(response: ProviderUsageResponse | null): boolean {
  if (!response) return false;
  const serverTime = Date.parse(response.serverTime);
  return Number.isFinite(serverTime)
    && Math.abs(Date.now() - serverTime) <= PROVIDER_USAGE_MAX_AGE_MS;
}

function validScope(scope: string): string | null {
  const trimmed = scope.trim();
  return trimmed.length > 0 && trimmed.length <= 512 ? trimmed : null;
}

export const useProviderUsage = create<ProviderUsageState>()((set, get) => ({
  status: "idle",
  response: null,
  runtimeScope: null,
  error: null,

  ensureRuntimeScope(scope) {
    const parsedScope = validScope(scope);
    if (parsedScope === get().runtimeScope) return;
    requestSequence += 1;
    inFlight = null;
    set({
      status: "idle",
      response: null,
      runtimeScope: parsedScope,
      error: null,
    });
  },

  async refresh(options = {}) {
    const scope = get().runtimeScope;
    if (!scope) return;
    if (!options.force && responseIsFresh(get().response)) return;
    if (inFlight?.scope === scope) return inFlight.promise;

    const sequence = ++requestSequence;
    const runtimeGeneration = captureRuntimeGeneration();
    set((state) => ({
      status: state.response ? "refreshing" : "loading",
      error: null,
    }));

    const promise = (async () => {
      try {
        const raw = await invoke("runtime:get-provider-usage", {
          forceRefresh: options.force === true,
        });
        const parsed = ProviderUsageResponseSchema.safeParse(raw);
        if (!parsed.success) throw new Error("invalid provider usage");
        if (
          sequence !== requestSequence
          || get().runtimeScope !== scope
          || !isCurrentRuntimeGeneration(runtimeGeneration)
        ) {
          return;
        }
        set({ status: "ready", response: parsed.data, error: null });
      } catch {
        if (
          sequence !== requestSequence
          || get().runtimeScope !== scope
          || !isCurrentRuntimeGeneration(runtimeGeneration)
        ) {
          return;
        }
        set({ status: "error", error: PROVIDER_USAGE_ERROR });
      } finally {
        if (inFlight?.sequence === sequence) inFlight = null;
      }
    })();

    inFlight = { scope, sequence, promise };
    return promise;
  },

  clear() {
    requestSequence += 1;
    inFlight = null;
    set({
      status: "idle",
      response: null,
      runtimeScope: null,
      error: null,
    });
  },
}));
