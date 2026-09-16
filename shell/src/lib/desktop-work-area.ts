// Match Electron Desktop's 38px header and 86px launch-bar reservation.
// The launch bar occupies 78px including its bottom offset; the remaining 8px
// keeps app content and resize handles clear of the bar.
export const WEB_DESKTOP_LAYOUT = {
  headerHeight: 38,
  launchBarReservedHeight: 86,
} as const;

export function desktopLaunchBarInset(hasDesktopChrome: boolean): number {
  return hasDesktopChrome ? WEB_DESKTOP_LAYOUT.launchBarReservedHeight : 0;
}

export function desktopWorkArea(
  viewport: { width: number; height: number },
  hasDesktopChrome: boolean,
): { width: number; height: number } {
  return {
    width: Math.max(1, Number.isFinite(viewport.width) ? viewport.width : 1),
    height: Math.max(1, (Number.isFinite(viewport.height) ? viewport.height : 1) - (hasDesktopChrome
      ? WEB_DESKTOP_LAYOUT.headerHeight + WEB_DESKTOP_LAYOUT.launchBarReservedHeight
      : 0)),
  };
}
