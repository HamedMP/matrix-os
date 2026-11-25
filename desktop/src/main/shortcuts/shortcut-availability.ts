// Which shortcut actions exist on a platform (specs/653). The application menu
// and the key matcher both ask here, so a missing menu item never leaves a key
// that is swallowed with nothing to run.
import type { ShortcutActionId } from "@matrix-os/contracts/keyboard-shortcuts";

export function isShortcutActionAvailable(id: ShortcutActionId, platform: NodeJS.Platform): boolean {
  // Windows has no Terminal window (spec 651).
  return id !== "terminal.window" || platform !== "win32";
}
