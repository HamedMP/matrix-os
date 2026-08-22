import {
  buildConversationProviderOptions,
  type ConversationProviderDefinition,
  type ConversationProviderOption,
  type ConversationProviderReadiness,
} from "./provider-options";

export interface ConversationProviderRegistration {
  definition: ConversationProviderDefinition;
  readiness: ConversationProviderReadiness;
  onActivate: () => void | Promise<void>;
}

export interface ConversationProviderRegistry {
  selectedId: string;
  options: readonly ConversationProviderOption[];
  activate: (providerId: string) => Promise<boolean>;
}

export function createConversationProviderRegistry({
  selectedId,
  providers,
}: {
  selectedId: string;
  providers: readonly ConversationProviderRegistration[];
}): ConversationProviderRegistry {
  const readinessById = Object.fromEntries(
    providers.map((provider) => [provider.definition.id, provider.readiness]),
  );
  const options = buildConversationProviderOptions(
    providers.map((provider) => provider.definition),
    readinessById,
  );

  return {
    selectedId,
    options,
    activate: async (providerId) => {
      const provider = providers.find((candidate) => candidate.definition.id === providerId);
      if (!provider || provider.readiness.state !== "ready") return false;
      await provider.onActivate();
      return true;
    },
  };
}
