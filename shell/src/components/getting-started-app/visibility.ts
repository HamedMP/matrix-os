/**
 * Whether the Getting started window is on screen in Web Desktop or Web Canvas. A minimized
 * window, or one covered by another fullscreen window, is not, so awards get the corner toast.
 */
export function webGettingStartedAppVisible(
  win: { id: string; minimized?: boolean },
  fullscreenWindowId: string | null,
): boolean {
  return !win.minimized && (fullscreenWindowId === null || fullscreenWindowId === win.id);
}
