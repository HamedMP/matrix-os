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
];

export function createGlobalChatProviderRegistry({
  selectedId,
  connected,
  onSelectProvider,
}: {
  selectedId: GlobalChatProviderId;
  connected: boolean;
  onSelectProvider: (providerId: GlobalChatProviderId) => void | Promise<void>;
}): ConversationProviderRegistry {
  return createConversationProviderRegistry({
    selectedId,
    providers: [
      {
        definition: GLOBAL_CHAT_PROVIDER_DEFINITIONS[0]!,
        readiness: connected
          ? { state: "ready" }
          : { state: "disabled", reason: "Connect a computer to use Claude." },
        onActivate: () => onSelectProvider("claude"),
      },
      {
        definition: GLOBAL_CHAT_PROVIDER_DEFINITIONS[1]!,
        readiness: connected
          ? { state: "ready" }
          : { state: "disabled", reason: "Connect a computer to use Codex." },
        onActivate: () => onSelectProvider("codex"),
      },
    ],
  });
}
