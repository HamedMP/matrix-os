import type { CanonicalChatModelSelection, CanonicalProviderCatalog } from "@matrix-os/contracts";

// Reached by path: `@matrix-os/ui` does not export it on its own, and its main
// entry also brings in the web components, which the native bundle cannot load.
import { chatPermissionModeLabel } from "../../../../packages/ui/src/chat/composer/permission-mode-label";

import { selectionCanRun } from "./model-choices";

export interface PermissionModeChoice {
  value: string;
  label: string;
  selected: boolean;
}

/**
 * The permission modes the selected engine runs a turn in, in the order it
 * lists them and named as Desktop's Permission mode menu names them
 * ("Auto Accept Edits"), with `current` marked. None when there is nothing to
 * choose, as on Desktop: the engine runs one mode only, or the selection
 * cannot run.
 */
export function permissionModeChoices(
  catalog: CanonicalProviderCatalog | null,
  selection: CanonicalChatModelSelection | null,
  current: string | null | undefined,
): PermissionModeChoice[] {
  if (!catalog || !selection || !selectionCanRun(catalog, selection)) return [];
  const modes = catalog.instances.find((candidate) => candidate.id === selection.instanceId)?.supports.permissionModes ?? [];
  if (modes.length < 2) return [];
  return modes.map((mode) => ({ value: mode, label: chatPermissionModeLabel(mode), selected: mode === current }));
}
