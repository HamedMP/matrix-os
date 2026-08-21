export type ConversationProviderIcon =
  | "hermes"
  | "codex"
  | "claude"
  | "opencode"
  | "pi"
  | "terminal";

export type ConversationProviderCapability =
  | "current-conversation"
  | "project-conversation"
  | "attachments"
  | "project-context"
  | "tools";

export interface ConversationProviderDefinition {
  id: string;
  label: string;
  icon: ConversationProviderIcon;
  capabilities: readonly ConversationProviderCapability[];
}

export type ConversationProviderReadiness =
  | { state: "ready" }
  | { state: "disabled"; reason: string };

export interface ConversationProviderOption extends ConversationProviderDefinition {
  readiness: ConversationProviderReadiness;
}

export function buildConversationProviderOptions(
  definitions: readonly ConversationProviderDefinition[],
  readinessById: Readonly<Record<string, ConversationProviderReadiness>>,
): ConversationProviderOption[] {
  return definitions.map((definition) => ({
    ...definition,
    readiness: readinessById[definition.id]
      ?? { state: "disabled", reason: "Provider availability is unknown." },
  }));
}
