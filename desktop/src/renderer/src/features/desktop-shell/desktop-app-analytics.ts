import type { DesktopAppKind } from "../../../../shared/desktop-analytics";
import type { Tab, TabKind } from "../../stores/tabs";
import type { DesktopAppId } from "./desktop-apps";

export const FIXED_APP_ANALYTICS_KINDS: Record<DesktopAppId, DesktopAppKind> = {
  work: "chat",
  terminal: "terminal",
  files: "files",
  editor: "editor",
  vscode: "vscode",
  settings: "settings",
  plugins: "plugins",
  browser: "browser",
  notes: "notes",
  whiteboard: "whiteboard",
};

const TAB_ANALYTICS_KINDS: Partial<Record<TabKind, DesktopAppKind>> = {
  browser: "browser",
  files: "files",
  editor: "editor",
  vscode: "vscode",
  notes: "notes",
  settings: "settings",
  terminal: "terminal",
  terminals: "terminal",
  task: "coding_agent",
  work: "chat",
  chat: "chat",
  projects: "chat",
  project: "chat",
};

export function analyticsKindForTab(
  tab: Pick<Tab, "kind" | "slug"> | undefined,
): DesktopAppKind | undefined {
  if (!tab) return undefined;
  if (tab.kind === "app") return tab.slug === "whiteboard" ? "whiteboard" : "installed_app";
  return TAB_ANALYTICS_KINDS[tab.kind];
}
