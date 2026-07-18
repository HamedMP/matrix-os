export const SHELL_Z_INDEX = {
  // Windows XP desktop icons: above the wallpaper (painted on <body>) but
  // below every app window — window z-order starts at
  // SHELL_WINDOW_Z_INDEX_START = 1.
  desktopIcons: 0,
  // Panel-local card elevation. This stays below app windows and only orders
  // sibling rows inside a shell surface.
  terminalSessionMenuCard: 30,
  // mac menu bar (standard + macOS-glass variants): floats above app windows
  // and the canvas but below the Windows taskbar, Settings, and hard gates.
  menuBar: 60,
  appWindowMax: 500,
  fullscreenWindow: 600,
  fullscreenExit: 601,
  // macOS Launchpad (macos-glass design): full-screen launcher take-over above
  // every app window and the dock, but below Settings and hard gates. Shares
  // the taskbar band; the two never co-render (different designs).
  launchpad: 650,
  // Windows-design taskbar + start menu: above every window (XP's taskbar is
  // "always on top" by default, Win11 keeps it above app windows too) but
  // below Settings, which must stay reachable over shell chrome.
  taskbar: 650,
  settings: 700,
  hardGate: 800,
  // Simulated OS session overlays (lock screens, XP welcome/log-off/shutdown
  // dialogs): above Settings and hard gates — they take over the whole screen —
  // but below the shared notification stack.
  lockScreen: 850,
  // Boot screens sit at the top of the session stack: a design-switch beat or
  // restart replay covers every other session overlay.
  bootScreen: 900,
  // Passive notification cards should stay above shell surfaces and gates, but
  // below active user-invoked menus that need to remain clickable when opened.
  notifications: 10000,
  // Floating menus/popovers (e.g. the account dropdown) portal to <body>, so they
  // must out-rank modal surfaces, hard gates, and passive notification cards.
  popover: 11000,
} as const;

export const SHELL_WINDOW_Z_INDEX_START = 1;
export const SHELL_WINDOW_Z_INDEX_MAX = SHELL_Z_INDEX.appWindowMax;
