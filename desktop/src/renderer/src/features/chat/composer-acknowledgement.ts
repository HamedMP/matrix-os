import { desktopProviderIdentityKey } from "../../lib/provider-settings-identity";
import { useConnection } from "../../stores/connection";
import { isCurrentRuntimeGeneration } from "../../stores/runtime-generation";

/** A retained draft belongs to its authenticated scope, not a replaceable HTTP client. */
export function createComposerAcknowledgement(input: {
  runtimeGeneration: number;
  identity: string;
  retained: boolean;
  client: unknown;
  currentClient(): unknown;
  settle(): void;
}) {
  return () => {
    if (!isCurrentRuntimeGeneration(input.runtimeGeneration)
      || desktopProviderIdentityKey(useConnection.getState()) !== input.identity
      || (!input.retained && input.currentClient() !== input.client)) return;
    input.settle();
  };
}
