import type { CanonicalChatModelSelection, CanonicalChatRecord, CanonicalProviderCatalog } from "@matrix-os/contracts";

import { catalogSelection, defaultCatalogSelection, startsChats } from "@/lib/canonical-chat-selection";

import { selectionCanRun } from "./model-choices";
import { selectionKeepingOptions } from "./model-options";

/**
 * A selection used before, as the catalog can run it now: the same engine and
 * model, the composer choices made for it (reasoning effort) where the engine
 * still offers them, and the account an own-account route runs through now.
 * Nothing when the engine, the model or the account is not there to run it.
 */
function restoredSelection(
  catalog: CanonicalProviderCatalog,
  saved: CanonicalChatModelSelection | null | undefined,
): CanonicalChatModelSelection | null {
  if (!saved) return null;
  const instance = catalog.instances.find((candidate) => candidate.id === saved.instanceId);
  if (!instance || !startsChats(instance) || !instance.models.some((model) => model.id === saved.model)) return null;
  const restored = selectionKeepingOptions(catalog, saved, catalogSelection(instance, saved.model));
  return selectionCanRun(catalog, restored) ? restored : null;
}

/** The selection of the most recently active chat that names one, wherever it was used last. */
function latestChatSelection(chats: readonly CanonicalChatRecord[]): CanonicalChatModelSelection | null {
  let latest: CanonicalChatModelSelection | null = null;
  let latestAt = Number.NEGATIVE_INFINITY;
  for (const { chat } of chats) {
    if (!chat.currentSelection || chat.lifecycle !== "active") continue;
    const at = Date.parse(chat.activityAt ?? chat.updatedAt);
    if (at > latestAt) {
      latest = chat.currentSelection;
      latestAt = at;
    }
  }
  return latest;
}

interface NewChatSelectionSources {
  /** The chats of the project the new chat starts in, if it starts in one. */
  projectChats?: readonly CanonicalChatRecord[];
  /** The last selection chosen on this phone. */
  remembered?: CanonicalChatModelSelection | null;
}

/**
 * The model a new chat starts on: the one the project's most recently active
 * chat uses, so it follows what was last used in the project on any device;
 * else the one last chosen on this phone; else the catalog's default. A
 * selection the catalog cannot run now is passed over for the next.
 */
export function newChatSelection(
  catalog: CanonicalProviderCatalog | null,
  { projectChats = [], remembered }: NewChatSelectionSources,
): CanonicalChatModelSelection | null {
  if (!catalog) return null;
  return restoredSelection(catalog, latestChatSelection(projectChats))
    ?? restoredSelection(catalog, remembered)
    ?? defaultCatalogSelection(catalog);
}
