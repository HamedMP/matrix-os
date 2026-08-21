import {
  buildConversationProviderOptions,
  type ConversationProviderDefinition,
  type ConversationProviderOption,
} from "../../components/conversation/provider-options";

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

export function globalChatProviderOptions({
  hermesReady,
  hasProject,
}: {
  hermesReady: boolean;
  hasProject: boolean;
}): ConversationProviderOption[] {
  return buildConversationProviderOptions(GLOBAL_CHAT_PROVIDER_DEFINITIONS, {
    hermes: hermesReady
      ? { state: "ready" }
      : { state: "disabled", reason: "Connect a computer to use Hermes." },
    codex: hasProject
      ? { state: "ready" }
      : { state: "disabled", reason: "Create a project to use Codex." },
  });
}
