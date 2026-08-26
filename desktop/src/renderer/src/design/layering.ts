export const DESKTOP_Z_INDEX = {
  nativeDesktopBackground: 0,
  nativeDesktopIcons: 1,
  nativeDesktopTabSurface: 2,
  nativeDesktopTabStrip: 4,
  nativeDesktopWindowStart: 10,
  nativeDesktopWindowMax: 40,
  nativeDesktopDrawerBackdrop: 41,
  nativeDesktopDrawer: 42,
  nativeDesktopLaunchpad: 44,
  nativeDesktopTaskbar: 45,
  dialog: 50,
  chrome: 2,
  popover: 100,
} as const;

export const NATIVE_DESKTOP_LAYOUT = {
  tabStripHeight: 38,
  taskbarReservedHeight: 86,
  resizeHandleSize: 16,
} as const;
