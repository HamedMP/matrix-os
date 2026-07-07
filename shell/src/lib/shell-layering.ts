export const SHELL_Z_INDEX = {
  // Panel-local card elevation. This stays below app windows and only orders
  // sibling rows inside a shell surface.
  terminalSessionMenuCard: 30,
  appWindowMax: 500,
  fullscreenWindow: 600,
  fullscreenExit: 601,
  settings: 700,
  hardGate: 800,
  // Floating menus/popovers (e.g. the account dropdown) portal to <body>, so they
  // must out-rank the modal surfaces they can be opened from (settings, hardGate).
  popover: 900,
  notifications: 10000,
} as const;

export const SHELL_WINDOW_Z_INDEX_START = 1;
export const SHELL_WINDOW_Z_INDEX_MAX = SHELL_Z_INDEX.appWindowMax;
