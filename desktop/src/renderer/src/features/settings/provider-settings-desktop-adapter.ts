import {
  ProviderConnectionAttemptActionSchema,
  ProviderSettingsMutationResponseSchema,
  ProviderSettingsMutationSchema,
  ProviderSettingsSnapshotSchema,
  type ProviderSettingsMutation,
  type ProviderSettingsMutationResponse,
  type ProviderSettingsSnapshot,
} from "@matrix-os/contracts";
import type {
  ProviderSettingsTransport,
  ProviderSettingsTransportErrorCode,
} from "@matrix-os/ui";
import { AppError } from "../../../../shared/app-error";
import { buildGatewayUrl, type ApiClient } from "../../lib/api";
import { invoke } from "../../lib/operator";
import { isValidShellSessionName, useShellSessions } from "../../stores/shell-sessions";
import { useTabs } from "../../stores/tabs";

const PROVIDER_SETTINGS_PATH = "/api/ai/provider-settings";
const PROVIDER_SETTINGS_ACTIONS_PATH = "/api/ai/provider-settings/actions";
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_MUTATION_BYTES = 64 * 1024;

export function desktopProviderIdentityKey(identity: {
  status: "loading" | "signed-out" | "signed-in";
  handle: string | null;
  platformHost: string;
  runtimeSlot: string;
  authGeneration: number;
}): string {
  return [
    identity.status,
    identity.handle ?? "none",
    identity.platformHost,
    identity.runtimeSlot,
    identity.authGeneration,
  ].join("|");
}

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
  getSnapshot(signal: AbortSignal): Promise<ProviderSettingsSnapshot>;
  mutate(mutation: ProviderSettingsMutation, signal: AbortSignal): Promise<ProviderSettingsMutationResponse>;
} {
  return {
    async getSnapshot(signal) {
      try {
        const value = await api.get<unknown>(PROVIDER_SETTINGS_PATH, {
          maxBytes: MAX_RESPONSE_BYTES,
          signal,
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
        const value = await api.post<unknown>(PROVIDER_SETTINGS_ACTIONS_PATH, mutation.data, {
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
  if (!isValidShellSessionName(terminalSessionId)) return false;
  const sessions = await useShellSessions.getState().load(api);
  if (!isIdentityCurrent()) return false;
  const exists = sessions?.some((session) => (
    session.name === terminalSessionId && session.status === "active"
  )) ?? false;
  if (!exists) return false;
  useTabs.getState().openTab({ kind: "terminals", title: "Terminal" });
  useTabs.getState().requestTerminalSession(terminalSessionId);
  return true;
}

type OpenExternal = (url: string) => Promise<unknown>;

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
  } catch {
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
