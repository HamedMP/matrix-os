import {
  createSharedCanonicalChatEventSource,
  type OnboardingAiConnectPort,
  type OnboardingChatPort,
  type OnboardingRepoSource,
} from "@matrix-os/ui";
import { z } from "zod/v4";
import { currentAiCreditRuntimeSlot } from "@/lib/ai-credit-checkout";
import { CanonicalShellChatRequestError, type CanonicalShellChatClient } from "@/lib/canonical-chat-client";
import { PROVIDER_SETTINGS_CHANGED_EVENT } from "@/lib/canonical-provider-setup";
import { getGatewayUrl } from "@/lib/gateway";
import { createWebProviderWorkflowClient, openWebProviderWorkflowAuthorization } from "@/lib/provider-workflow-transport";

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

/** Raised instead of sending once the page talks to another computer; the widget remounts for the new one. */
export class ShellOnboardingComputerChangedError extends Error {
  override readonly name = "ShellOnboardingComputerChangedError";
  constructor() {
    super("OnboardingComputerChanged");
  }
}

/** Names the computer and runtime this page talks to now; ports bound to an older value must stop sending. */
export function shellOnboardingTransportKey(): string {
  return `${getGatewayUrl()}|${currentAiCreditRuntimeSlot()}`;
}

function whileCurrent<T>(isCurrent: () => boolean, call: () => Promise<T>): Promise<T> {
  return isCurrent() ? call() : Promise.reject(new ShellOnboardingComputerChangedError());
}

export function createShellOnboardingChatPort(client: CanonicalShellChatClient, isCurrent: () => boolean = () => true): OnboardingChatPort {
  return {
    create: (input) => whileCurrent(isCurrent, () => client.create(input)),
    detail: (chatId) => whileCurrent(isCurrent, () => client.detail(chatId)),
    admitTurn: (chatId, input) => whileCurrent(isCurrent, () => client.admitTurn(chatId, input)),
    isNotFound: isShellNotFound,
    isComputerStarting: isShellComputerStarting,
    watch(chatId, onChange) {
      if (!isCurrent()) return () => undefined;
      const eventSource = createSharedCanonicalChatEventSource({
        openStream: (input) => {
          if (isCurrent()) return client.openEventStream(input);
          // Disposing first stops the source from reconnecting to a computer this page no longer shows.
          eventSource.dispose();
          return Promise.reject(new ShellOnboardingComputerChangedError());
        },
      });
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

async function boundedJson(response: Response): Promise<unknown> {
  if (!response.ok) throw new Error(`OnboardingRepoRequestFailed:${response.status}`);
  const text = await response.text();
  if (text.length > MAX_REPO_RESPONSE_BYTES) throw new Error("OnboardingRepoResponseTooLarge");
  return JSON.parse(text);
}

export function createShellOnboardingRepoSource(
  gatewayUrl: string,
  fetchFn: typeof fetch = fetch,
  isCurrent: () => boolean = () => true,
): OnboardingRepoSource {
  const signalFor = (signal: AbortSignal) => AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
  return {
    readGithubApp: (request, signal) => whileCurrent(isCurrent, async () => boundedJson(await fetchFn(`${gatewayUrl}/api/integrations/read-call`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      signal: signalFor(signal),
    }))),
    listComputerRepos: (limit, signal) => whileCurrent(isCurrent, async () => boundedJson(await fetchFn(`${gatewayUrl}/api/github/repos?limit=${limit}`, {
      signal: signalFor(signal),
    }))),
  };
}

export function createShellOnboardingAiPort(isCurrent: () => boolean): OnboardingAiConnectPort {
  return {
    client: createWebProviderWorkflowClient({ isIdentityCurrent: isCurrent }),
    openAuthorization: (url) => isCurrent() && openWebProviderWorkflowAuthorization(url),
    isIdentityCurrent: isCurrent,
    onConnected: () => {
      if (isCurrent()) window.dispatchEvent(new Event(PROVIDER_SETTINGS_CHANGED_EVENT));
    },
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
