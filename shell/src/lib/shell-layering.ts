export const SHELL_Z_INDEX = {
  // Collapsed Terminal rail elevation while its session menu is open. This must
  // outrank xterm's link canvas (z-index 2) without escaping the app surface.
  terminalCollapsedRailMenu: 3,
  // Panel-local card elevation. This stays below app windows and only orders
  // sibling rows inside a shell surface.
  terminalSessionMenuCard: 30,
  appWindowMax: 500,
  fullscreenWindow: 600,
  fullscreenExit: 601,
  settings: 700,
  hardGate: 800,
  // Passive notification cards should stay above shell surfaces and gates, but
  // below active user-invoked menus that need to remain clickable when opened.
  notifications: 10000,
  // Floating menus/popovers (e.g. the account dropdown) portal to <body>, so they
  // must out-rank modal surfaces, hard gates, and passive notification cards.
  popover: 11000,
} as const;

export const SHELL_WINDOW_Z_INDEX_START = 1;
export const SHELL_WINDOW_Z_INDEX_MAX = SHELL_Z_INDEX.appWindowMax;
