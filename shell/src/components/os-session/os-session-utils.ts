import {
  loadShellSnapshot,
  type ShellSnapshotScope,
} from "@/lib/shell-snapshot-cache";

/** Designs that get an OS-authentic boot screen. */
export type OsBootDesign = "macos-glass" | "winxp" | "win11";

/** How long the design-switch boot beat stays up (~1.2–2s per spec). */
export const BOOT_BEAT_MS = 1500;

export function isBootDesign(style: string | null | undefined): style is OsBootDesign {
  return style === "macos-glass" || style === "winxp" || style === "win11";
}

/**
 * Design persisted in the shell snapshot cache. The theme hook seeds itself
 * from the same snapshot before its server fetch lands, so this is the
 * pre-paint design; null when unknown (first run) or on the server.
 */
export function readPersistedThemeStyle(
  scope: ShellSnapshotScope | null | undefined,
): string | null {
  if (!scope) return null;
  const style = loadShellSnapshot(scope)?.theme?.style;
  return typeof style === "string" ? style : null;
}
