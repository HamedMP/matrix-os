export const OS_VIEW_CORE_APP_FIXTURE = [
  { id: "chat", name: "Chat", path: "__chat__" },
  { id: "settings", name: "Settings", path: "__settings__" },
  { id: "terminal", name: "Terminal", path: "__terminal__" },
  { id: "files", name: "Files", path: "__file-browser__" },
] as const;

export const OS_VIEW_FIXED_APP_NAMES = [
  "Chat",
  "Terminal",
  "Files",
  "Editor",
  "VS Code",
  "Settings",
  "Plugins",
  "Browser",
  "Notes",
  "Whiteboard",
] as const;

export const OS_VIEW_PARITY_SURFACES = [
  "Web Canvas",
  "Web Desktop",
  "Electron Desktop",
] as const;
