import {
  type ConversationProviderDefinition,
} from "../../components/conversation/provider-options";
import {
  createConversationProviderRegistry,
  type ConversationProviderRegistry,
} from "../../components/conversation/provider-registry";
import type { GlobalChatProviderId } from "@matrix-os/contracts";

const GLOBAL_CHAT_PROVIDER_DEFINITIONS: readonly ConversationProviderDefinition[] = [
  {
    id: "claude",
    label: "Claude",
    icon: "claude",
    capabilities: ["current-conversation", "attachments", "project-context", "tools"],
  },
  {
    id: "codex",
    label: "Codex",
    icon: "codex",
    capabilities: ["project-conversation", "tools"],
  },
  {
    id: "pi",
    label: "Pi",
    icon: "pi",
    capabilities: ["project-conversation", "tools"],
  },
];

export function createGlobalChatProviderRegistry({
  selectedId,
  connected,
  availableProviderIds,
  onSelectProvider,
}: {
  selectedId: GlobalChatProviderId;
  connected: boolean;
  availableProviderIds: readonly GlobalChatProviderId[];
  onSelectProvider: (providerId: GlobalChatProviderId) => void | Promise<void>;
}): ConversationProviderRegistry {
  const ready = new Set(availableProviderIds);
  const codingAgentReadiness = (providerId: Exclude<GlobalChatProviderId, "claude">) => {
    if (!connected) {
      return { state: "disabled" as const, reason: `Connect a computer to use ${providerId === "codex" ? "Codex" : "Pi"}.` };
    }
    return ready.has(providerId)
      ? { state: "ready" as const }
      : {
          state: "disabled" as const,
          reason: `Install or connect ${providerId === "codex" ? "Codex" : "Pi"} before using it.`,
        };
  };
  return createConversationProviderRegistry({
    selectedId,
    providers: [
      {
        definition: GLOBAL_CHAT_PROVIDER_DEFINITIONS[0]!,
        readiness: connected && ready.has("claude")
          ? { state: "ready" }
          : { state: "disabled", reason: "Connect a computer to use Claude." },
        onActivate: () => onSelectProvider("claude"),
      },
      {
        definition: GLOBAL_CHAT_PROVIDER_DEFINITIONS[1]!,
        readiness: codingAgentReadiness("codex"),
        onActivate: () => onSelectProvider("codex"),
      },
      {
        definition: GLOBAL_CHAT_PROVIDER_DEFINITIONS[2]!,
        readiness: codingAgentReadiness("pi"),
        onActivate: () => onSelectProvider("pi"),
      },
    ],
  });
}
