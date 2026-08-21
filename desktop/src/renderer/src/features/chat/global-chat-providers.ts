import {
  type ConversationProviderDefinition,
} from "../../components/conversation/provider-options";
import {
  createConversationProviderRegistry,
  type ConversationProviderRegistry,
} from "../../components/conversation/provider-registry";

const GLOBAL_CHAT_PROVIDER_DEFINITIONS: readonly ConversationProviderDefinition[] = [
  {
    id: "hermes",
    label: "Hermes",
    icon: "hermes",
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
  hermesReady,
  hasProject,
  onUseCurrentConversation,
  onOpenProjectConversation,
}: {
  hermesReady: boolean;
  hasProject: boolean;
  onUseCurrentConversation: () => void | Promise<void>;
  onOpenProjectConversation: () => void | Promise<void>;
}): ConversationProviderRegistry {
  return createConversationProviderRegistry({
    selectedId: "hermes",
    providers: [
      {
        definition: GLOBAL_CHAT_PROVIDER_DEFINITIONS[0]!,
        readiness: hermesReady
          ? { state: "ready" }
          : { state: "disabled", reason: "Connect a computer to use Hermes." },
        onActivate: onUseCurrentConversation,
      },
      {
        definition: GLOBAL_CHAT_PROVIDER_DEFINITIONS[1]!,
        readiness: hasProject
          ? { state: "ready" }
          : { state: "disabled", reason: "Create a project to use Codex." },
        onActivate: onOpenProjectConversation,
      },
    ],
  });
}
