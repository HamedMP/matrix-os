import {
  ProviderConnectionAttemptActionSchema,
  ProviderSettingsMutationResponseSchema,
  ProviderSettingsMutationSchema,
  ProviderSettingsSnapshotSchema,
  FUNDED_AI_READINESS_TIMEOUTS,
  FUNDED_AI_CHECKOUT_TIMEOUT_MS,
  type ProviderSettingsMutation,
  type ProviderSettingsMutationResponse,
  type ProviderSettingsSnapshot,
  type ProviderHarnessKind,
} from "@matrix-os/contracts";
import { openProviderAgentSetup } from "@matrix-os/ui";
import type {
  ProviderSettingsTransport,
  ProviderSettingsTransportErrorCode,
} from "@matrix-os/ui";
import { AppError } from "../../../../shared/app-error";
import { buildGatewayUrl, type ApiClient } from "../../lib/api";
import { invoke } from "../../lib/operator";
import { isValidShellSessionName, readShellSessions, useShellSessions, type ShellSessionSummary } from "../../stores/shell-sessions";
import { captureRuntimeGeneration, isCurrentRuntimeGeneration } from "../../stores/runtime-generation";
import { useTabs } from "../../stores/tabs";
import { useDesktopSurfaces } from "../../stores/desktop-surfaces";

const PROVIDER_SETTINGS_PATH = "/api/ai/provider-settings";
const PROVIDER_SETTINGS_ACTIONS_PATH = "/api/ai/provider-settings/actions";
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_MUTATION_BYTES = 64 * 1024;
const MAX_CHECKOUT_RESPONSE_BYTES = 8 * 1024;
let latestTerminalHandoff: symbol | undefined;

export { desktopProviderIdentityKey } from "../../lib/provider-settings-identity";

class DesktopProviderSettingsTransportError extends Error {
  constructor(readonly code: ProviderSettingsTransportErrorCode) {
    super("Provider settings are unavailable.");
    this.name = "DesktopProviderSettingsTransportError";
  }
}

function mapTransportError(error: unknown): DesktopProviderSettingsTransportError {
  if (error instanceof DesktopProviderSettingsTransportError) return error;
  if (error instanceof AppError) {
    if (error.detail === "revision_conflict"
      || error.detail === "idempotency_conflict"
      || error.detail === "provider_settings_unavailable") {
      return new DesktopProviderSettingsTransportError(error.detail);
    }
  }
  return new DesktopProviderSettingsTransportError("unavailable");
}

export function createDesktopProviderSettingsTransport(api: ApiClient): ProviderSettingsTransport & {
  getSnapshot(signal: AbortSignal, options?: { refresh?: boolean }): Promise<ProviderSettingsSnapshot>;
  mutate(mutation: ProviderSettingsMutation, signal: AbortSignal): Promise<ProviderSettingsMutationResponse>;
} {
  return {
    async getSnapshot(signal, options = {}) {
      try {
        const value = await api.get<unknown>(`${PROVIDER_SETTINGS_PATH}?includeCapabilities=true&includeModelCapabilities=true${options.refresh ? "&refresh=true" : ""}`, {
          maxBytes: MAX_RESPONSE_BYTES,
          signal,
          timeoutMs: FUNDED_AI_READINESS_TIMEOUTS.rendererRequestMs,
        });
        const parsed = ProviderSettingsSnapshotSchema.safeParse(value);
        if (!parsed.success) throw new DesktopProviderSettingsTransportError("invalid_response");
        return parsed.data;
      } catch (error) {
        throw mapTransportError(error);
      }
    },
    async mutate(input, signal) {
      const mutation = ProviderSettingsMutationSchema.safeParse(input);
      if (!mutation.success) throw new DesktopProviderSettingsTransportError("invalid_request");
      const encoded = new TextEncoder().encode(JSON.stringify(mutation.data));
      if (encoded.byteLength > MAX_MUTATION_BYTES) {
        throw new DesktopProviderSettingsTransportError("invalid_request");
      }
      try {
        const value = await api.post<unknown>(`${PROVIDER_SETTINGS_ACTIONS_PATH}?includeCapabilities=true&includeModelCapabilities=true`, mutation.data, {
          maxBytes: MAX_RESPONSE_BYTES,
          signal,
        });
        const parsed = ProviderSettingsMutationResponseSchema.safeParse(value);
        if (!parsed.success) throw new DesktopProviderSettingsTransportError("invalid_response");
        return parsed.data;
      } catch (error) {
        throw mapTransportError(error);
      }
    },
  };
}

export async function openExistingProviderTerminalSession(
  api: ApiClient,
  terminalSessionId: string,
  isIdentityCurrent: () => boolean = () => true,
): Promise<boolean> {
  if (!isValidShellSessionName(terminalSessionId) || !isIdentityCurrent()) return false;
  const handoff = Symbol();
  latestTerminalHandoff = handoff;
  const generation = captureRuntimeGeneration();
  const revision = useShellSessions.getState().authoritativeRevision;
  const sequence = useShellSessions.getState().loadSequence + 1;
  // Invalidate polls issued before this read, while allowing polls issued after
  // it to complete normally. Completion order alone is not snapshot freshness.
  useShellSessions.setState({ loadSequence: sequence, loading: true, error: null });
  // A background poll can supersede store.load while this user action waits.
  // Validate the handoff independently without weakening latest-only polling.
  try {
    const sessions: ShellSessionSummary[] = await readShellSessions(api);
    if (latestTerminalHandoff !== handoff || !isIdentityCurrent() || !isCurrentRuntimeGeneration(generation)) return false;
    const current = useShellSessions.getState();
    // A completed newer list or deletion owns the truth. In-flight polls alone
    // cannot turn this successfully validated exact reference into "missing".
    const superseded = current.authoritativeRevision !== revision;
    const authoritativeSessions = superseded ? current.sessions : sessions;
    if (!superseded) {
      useShellSessions.setState((state) => ({
        sessions,
        authoritativeRevision: state.authoritativeRevision + 1,
      }));
    }
    const exists = authoritativeSessions.some((session) => (
      session.name === terminalSessionId && session.status === "active"
    ));
    if (!exists) return false;
    const tabId = useTabs.getState().openTab({ kind: "terminals", title: "Terminal" });
    useDesktopSurfaces.getState().activateSurface(tabId);
    useTabs.getState().requestTerminalSession(terminalSessionId);
    return true;
  } catch (error) {
    console.warn("[provider-settings] Terminal handoff unavailable:", error instanceof Error ? error.name : typeof error);
    return false;
  } finally {
    if (latestTerminalHandoff === handoff && isCurrentRuntimeGeneration(generation)
      && useShellSessions.getState().loadSequence === sequence) {
      useShellSessions.setState({ loading: false });
    }
  }
}

export async function openDesktopProviderAgentSetup(
  api: ApiClient,
  harness: ProviderHarnessKind,
  isIdentityCurrent: () => boolean,
): Promise<boolean> {
  return openProviderAgentSetup({
    harness,
    getCatalog: () => api.get("/api/chat-providers?refresh=true&includeConnectionLabels=true", {
      maxBytes: MAX_RESPONSE_BYTES, timeoutMs: FUNDED_AI_READINESS_TIMEOUTS.rendererRequestMs,
      signal: AbortSignal.timeout(FUNDED_AI_READINESS_TIMEOUTS.rendererRequestMs),
    }),
    openCommand: async (cmd) => {
      if (!isIdentityCurrent()) return false;
      const session = await useShellSessions.getState().create(api, { cmd });
      if (!session || !isIdentityCurrent()) return false;
      return openExistingProviderTerminalSession(api, session.name, isIdentityCurrent);
    },
  });
}

type OpenExternal = (url: string) => Promise<unknown>;

function isStripeCheckoutUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "checkout.stripe.com";
  } catch {
    return false;
  }
}

export async function openAiCreditCheckout(input: {
  api: ApiClient;
  runtimeSlot: string;
  packageId: "usd_5" | "usd_10" | "usd_25";
  requestId: string;
  openExternal?: OpenExternal;
  signal?: AbortSignal;
  isIdentityCurrent?: () => boolean;
}): Promise<boolean> {
  const timeout = AbortSignal.timeout(FUNDED_AI_CHECKOUT_TIMEOUT_MS);
  const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
  try {
    if (input.isIdentityCurrent?.() === false) return false;
    signal.throwIfAborted();
    const result = await input.api.post<unknown>("/billing/ai-credit/checkout", {
      packageId: input.packageId,
      runtimeSlot: input.runtimeSlot,
      requestId: input.requestId,
    }, { maxBytes: MAX_CHECKOUT_RESPONSE_BYTES, timeoutMs: FUNDED_AI_CHECKOUT_TIMEOUT_MS, signal });
    signal.throwIfAborted();
    const url = result && typeof result === "object" ? (result as { url?: unknown }).url : undefined;
    if (!isStripeCheckoutUrl(url)) return false;
    if (input.isIdentityCurrent?.() === false) return false;
    const openExternal = input.openExternal ?? ((target) => invoke("shell:open-external", { url: target }));
    await openExternal(url);
    return true;
  } catch (error) {
    console.warn("[ai-credit] Checkout unavailable:", error instanceof Error ? error.name : typeof error);
    return false;
  }
}

export async function openProviderAuthorizationPath(input: {
  authorizationPath: string;
  platformHost: string;
  runtimeSlot: string;
  openExternal?: OpenExternal;
}): Promise<boolean> {
  const action = ProviderConnectionAttemptActionSchema.safeParse({
    kind: "open_browser",
    authorizationPath: input.authorizationPath,
  });
  if (!action.success || action.data.kind !== "open_browser") return false;
  const url = buildGatewayUrl(input.platformHost, action.data.authorizationPath, input.runtimeSlot);
  try {
    if (new URL(url).protocol !== "https:") return false;
  } catch (error) {
    console.warn("[provider-settings] Invalid authorization URL:", error instanceof Error ? error.name : typeof error);
    return false;
  }
  try {
    const openExternal = input.openExternal ?? ((target) => invoke("shell:open-external", { url: target }));
    await openExternal(url);
    return true;
  } catch (error) {
    console.error(
      "[provider-settings] Could not open authorization page:",
      error instanceof Error ? error.name : typeof error,
    );
    return false;
  }
}
