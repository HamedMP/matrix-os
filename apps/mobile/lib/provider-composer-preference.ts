import type { CanonicalChatModelSelection, CanonicalProviderCatalog } from "@matrix-os/contracts";
import { selectionKeepingOptions } from "@/components/chat/model-options";
import { chosenTurnModes } from "./canonical-chat-selection";
import type { RememberedComposerChoice } from "./remembered-composer-choice";

/** Explicit models win; only a provider switch restores destination defaults. */
export function providerComposerPreference(
  catalog: CanonicalProviderCatalog | null,
  current: CanonicalChatModelSelection | null,
  chosen: CanonicalChatModelSelection,
  destination: RememberedComposerChoice | null,
  currentPermission: string | null | undefined,
): RememberedComposerChoice & { selection: CanonicalChatModelSelection } {
  const switching = current?.instanceId !== chosen.instanceId;
  const selection = switching ? selectionKeepingOptions(catalog, destination?.selection ?? null, chosen) : chosen;
  const permissionMode = switching
    ? chosenTurnModes(catalog, selection, undefined, destination?.permissionMode)?.permissionMode
    : currentPermission ?? undefined;
  return { selection, permissionMode };
}
