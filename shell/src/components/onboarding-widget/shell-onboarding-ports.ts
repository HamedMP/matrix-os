import {
  createSharedCanonicalChatEventSource,
  type OnboardingAiConnectPort,
  type OnboardingChatPort,
  type OnboardingRepoSource,
} from "@matrix-os/ui";
import { z } from "zod/v4";
import { PROVIDER_SETTINGS_CHANGED_EVENT } from "@/lib/canonical-provider-setup";
import { CanonicalShellChatRequestError, type CanonicalShellChatClient } from "@/lib/canonical-chat-client";
import { createWebProviderWorkflowClient, openWebProviderWorkflowAuthorization } from "@/lib/provider-workflow-transport";
import { boundedProviderSettingsJson } from "@/lib/provider-settings-transport";

const REQUEST_TIMEOUT_MS = 10_000;
const MAX_REPO_RESPONSE_BYTES = 512 * 1024;
const GATEWAY_STARTING_STATUSES = new Set([502, 503, 504]);
const SAFE_RUNTIME_SLOT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const SAFE_HANDLE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

/** Network failures and gateway outages mean the computer is still waking; everything else is a real failure. */
export function isShellComputerStarting(error: unknown): boolean {
  if (error instanceof CanonicalShellChatRequestError) return GATEWAY_STARTING_STATUSES.has(error.status);
  if (error instanceof DOMException) return error.name === "TimeoutError";
  return error instanceof TypeError;
}

export function isShellNotFound(error: unknown): boolean {
  return error instanceof CanonicalShellChatRequestError && error.status === 404;
}

export function createShellOnboardingChatPort(client: CanonicalShellChatClient): OnboardingChatPort {
  return {
    create: (input) => client.create(input),
    detail: (chatId, cursor) => client.detail(chatId, cursor),
    admitTurn: (chatId, input) => client.admitTurn(chatId, input),
    isNotFound: isShellNotFound,
    isComputerStarting: isShellComputerStarting,
    watch(chatId, onChange) {
      const eventSource = createSharedCanonicalChatEventSource({ openStream: (input) => client.openEventStream(input) });
      const subscription = eventSource.subscribe((event) => {
        if (event.type === "chat.full_refresh" || event.chatId === chatId) onChange();
      });
      void eventSource.start();
      return () => {
        subscription.dispose();
        eventSource.dispose();
      };
    },
  };
}

/** Stops reading at the size limit, so an oversized repo list is never fully downloaded. */
async function boundedJson(response: Response): Promise<unknown> {
  if (!response.ok) throw new Error(`OnboardingRepoRequestFailed:${response.status}`);
  return boundedProviderSettingsJson(response, MAX_REPO_RESPONSE_BYTES);
}

/** Bound to the computer the widget opened; in-app routes such as /shared must not move these requests. */
export function createShellOnboardingAiPort(gatewayUrl: string, fetcher: typeof fetch = fetch): OnboardingAiConnectPort {
  return {
    client: createWebProviderWorkflowClient({ gatewayUrl, fetcher }),
    openAuthorization: openWebProviderWorkflowAuthorization,
    isIdentityCurrent: () => true,
    onConnected: () => window.dispatchEvent(new Event(PROVIDER_SETTINGS_CHANGED_EVENT)),
  };
}

export function createShellOnboardingRepoSource(gatewayUrl: string, fetchFn: typeof fetch = fetch): OnboardingRepoSource {
  const signalFor = (signal: AbortSignal) => AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
  return {
    readGithubApp: async (request, signal) => boundedJson(await fetchFn(`${gatewayUrl}/api/integrations/read-call`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      signal: signalFor(signal),
    })),
    listComputerRepos: async (limit, signal) => boundedJson(await fetchFn(`${gatewayUrl}/api/github/repos?limit=${limit}`, {
      signal: signalFor(signal),
    })),
  };
}

const IdentitySchema = z.object({
  handle: z.string().max(64).optional(),
  displayName: z.string().max(200).optional(),
}).loose();

const SystemInfoSchema = z.object({
  runtime: z.object({ runtimeSlot: z.string().max(64).nullable().optional() }).loose().nullable().optional(),
}).loose();

export interface ShellOnboardingIdentity {
  handle: string;
  runtimeSlot: string;
  displayName: string | null;
}

/** Local dev and fresh homes have no handle yet; they still get one stable prefs scope. */
export function shellOnboardingIdentity(identity: unknown, systemInfo: unknown): ShellOnboardingIdentity {
  const parsedIdentity = IdentitySchema.safeParse(identity);
  const parsedSystem = SystemInfoSchema.safeParse(systemInfo);
  const handle = parsedIdentity.success ? parsedIdentity.data.handle?.trim() ?? "" : "";
  const displayName = parsedIdentity.success ? parsedIdentity.data.displayName?.trim() || null : null;
  const slot = parsedSystem.success ? parsedSystem.data.runtime?.runtimeSlot ?? "" : "";
  return {
    handle: SAFE_HANDLE.test(handle) ? handle : "owner",
    runtimeSlot: SAFE_RUNTIME_SLOT.test(slot) ? slot : "primary",
    displayName,
  };
}
