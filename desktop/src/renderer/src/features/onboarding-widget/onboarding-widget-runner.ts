import { chatMessageVersionUrl, chatReadStateVersionUrl } from "@matrix-os/contracts";
import {
  admitOnboardingTurn as admitSharedOnboardingTurn,
  loadOnboardingRepos as loadSharedOnboardingRepos,
  type CanonicalComposerSelection,
  type OnboardingAdmissionRequestIds,
  type OnboardingChatPort,
  type OnboardingRepoSource,
  type OnboardingWidgetRepo,
} from "@matrix-os/ui";
import { AppError } from "../../../../shared/app-error";
import type { ApiClient } from "../../lib/api";
import { createCanonicalChatEventSource, type CanonicalChatClient } from "../../lib/canonical-chat-client";

export {
  ONBOARDING_CHAT_TITLE,
  ONBOARDING_MAX_APPS,
  ONBOARDING_MAX_REPOS,
  onboardingAdmissionRequestIds,
  onboardingApps,
  onboardingConnectedProviders,
  onboardingCreditsExhausted,
  onboardingSelection,
  pickProviderConnectionOption,
  relativeUpdatedLabel,
} from "@matrix-os/ui";

/** Network-level failures mean the computer is still waking; everything else is a real failure. */
export function isComputerStartingError(error: unknown): boolean {
  return error instanceof AppError && (error.category === "offline" || error.category === "timeout");
}

function isNotFoundError(error: unknown): boolean {
  return error instanceof AppError && error.category === "notFound";
}

export function createDesktopOnboardingRepoSource(api: Pick<ApiClient, "get" | "post">): OnboardingRepoSource {
  return {
    readGithubApp: (request, signal) => api.post<unknown>("/api/integrations/read-call", request, { signal, timeoutMs: 10_000, maxBytes: 512 * 1024 }),
    listComputerRepos: (limit, signal) => api.get<unknown>(`/api/github/repos?limit=${limit}`, { signal, timeoutMs: 10_000, maxBytes: 256 * 1024 }),
  };
}

export function loadOnboardingRepos(
  api: Pick<ApiClient, "get" | "post">,
  github: { id: string; accountLabel: string } | null,
  signal: AbortSignal,
): Promise<OnboardingWidgetRepo[]> {
  return loadSharedOnboardingRepos(createDesktopOnboardingRepoSource(api), github, signal);
}

type DesktopChatClient = Pick<CanonicalChatClient, "create" | "getDetail" | "admitTurn">;

function desktopChatTurns(client: DesktopChatClient): Pick<OnboardingChatPort, "create" | "detail" | "admitTurn" | "isNotFound"> {
  return {
    create: (input) => client.create(input),
    detail: (chatId, cursor) => (cursor === undefined ? client.getDetail(chatId) : client.getDetail(chatId, { cursor })),
    admitTurn: (chatId, input) => client.admitTurn(chatId, input, { chatScope: "global" }),
    isNotFound: isNotFoundError,
  };
}

export function createDesktopOnboardingChatPort(api: ApiClient, client: CanonicalChatClient): OnboardingChatPort {
  return {
    ...desktopChatTurns(client),
    isComputerStarting: isComputerStartingError,
    watch(chatId, onChange) {
      const eventSource = createCanonicalChatEventSource({
        openStream({ cursor, signal }) {
          return api.openStream(chatReadStateVersionUrl(chatMessageVersionUrl("/api/chats/events")), {
            accept: "text/event-stream", signal, timeoutMs: 5 * 60 * 1000,
            headers: { "x-matrix-chat-protocol": "2", ...(cursor === undefined ? {} : { "last-event-id": String(cursor) }) },
          });
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

export function admitOnboardingTurn({ client, chatId, prompt, selection, requestIds }: {
  client: DesktopChatClient;
  chatId: string | null;
  prompt: string;
  selection: CanonicalComposerSelection;
  requestIds: OnboardingAdmissionRequestIds;
}): Promise<{ chatId: string; runId: string }> {
  return admitSharedOnboardingTurn({ port: desktopChatTurns(client), chatId, prompt, selection, requestIds });
}
