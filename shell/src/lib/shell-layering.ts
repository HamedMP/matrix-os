export const SHELL_Z_INDEX = {
  appWindowMax: 89,
  fullscreenWindow: 100,
  fullscreenExit: 101,
  settings: 110,
  hardGate: 120,
  notifications: 10000,
} as const;

export const SHELL_Z_CLASSES = {
  fullscreenExit: "z-[101]",
  settings: "z-[110]",
  hardGate: "z-[120]",
  notifications: "z-[10000]",
} as const;

export const SHELL_WINDOW_Z_INDEX_START = 1;
export const SHELL_WINDOW_Z_INDEX_MAX = SHELL_Z_INDEX.appWindowMax;
