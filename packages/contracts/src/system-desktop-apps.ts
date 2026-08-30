export type SystemDesktopAppId =
  | "chat"
  | "terminal"
  | "files"
  | "editor"
  | "vscode"
  | "settings"
  | "plugins"
  | "browser"
  | "notes"
  | "whiteboard";

export type SystemDesktopAppIconKey =
  | "message-square"
  | "square-terminal"
  | "folder-tree"
  | "file-pen-line"
  | "code-2"
  | "settings"
  | "blocks"
  | "globe-2"
  | "notebook"
  | "brush";

export interface SystemDesktopAppDefinition {
  id: SystemDesktopAppId;
  name: string;
  iconKey: SystemDesktopAppIconKey;
  color: string;
  iconColor: string;
}

export const SYSTEM_DESKTOP_APPS: readonly SystemDesktopAppDefinition[] = [
  { id: "chat", name: "Chat", iconKey: "message-square", color: "var(--surface-error-emphasis, #BA5236)", iconColor: "white" },
  { id: "terminal", name: "Terminal", iconKey: "square-terminal", color: "var(--surface-warning-emphasis, #E0AA52)", iconColor: "white" },
  { id: "files", name: "Files", iconKey: "folder-tree", color: "var(--surface-brand-emphasis, #748E59)", iconColor: "white" },
  { id: "editor", name: "Editor", iconKey: "file-pen-line", color: "#4D7FA8", iconColor: "white" },
  { id: "vscode", name: "VS Code", iconKey: "code-2", color: "#FFFEFC", iconColor: "#007ACC" },
  { id: "settings", name: "Settings", iconKey: "settings", color: "var(--surface-neutral-emphasis, #6B7280)", iconColor: "white" },
  { id: "plugins", name: "Plugins", iconKey: "blocks", color: "#7C6DB4", iconColor: "white" },
  { id: "browser", name: "Browser", iconKey: "globe-2", color: "var(--surface-info-emphasis, #3B85BA)", iconColor: "white" },
  { id: "notes", name: "Notes", iconKey: "notebook", color: "var(--surface-purple-emphasis)", iconColor: "white" },
  { id: "whiteboard", name: "Whiteboard", iconKey: "brush", color: "#D46A92", iconColor: "white" },
] as const;

export const SYSTEM_DESKTOP_APP_BY_ID = Object.fromEntries(
  SYSTEM_DESKTOP_APPS.map((app) => [app.id, app]),
) as Readonly<Record<SystemDesktopAppId, SystemDesktopAppDefinition>>;
