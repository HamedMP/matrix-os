export const SHELL_Z_INDEX = {
  appWindowMax: 500,
  fullscreenWindow: 600,
  fullscreenExit: 601,
  settings: 700,
  hardGate: 800,
  notifications: 10000,
} as const;

export const SHELL_WINDOW_Z_INDEX_START = 1;
export const SHELL_WINDOW_Z_INDEX_MAX = SHELL_Z_INDEX.appWindowMax;
