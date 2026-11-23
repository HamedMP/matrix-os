import { currentNavigatorPlatform, desktopPlatform } from "./desktop-platform";

export function desktopShortcutLabel(keys: string, platform = currentNavigatorPlatform()): string {
  return `${desktopPlatform(platform) === "mac" ? "⌘" : "Ctrl+"}${keys}`;
}

/** Task workspace panel toggles: Cmd+Alt+digit on mac, Ctrl+Alt+digit elsewhere. */
export function taskPanelShortcutLabel(panel: number, platform = currentNavigatorPlatform()): string {
  return `${desktopPlatform(platform) === "mac" ? "⌘⌥" : "Ctrl+Alt+"}${panel}`;
}

export function systemTerminalLabel(platform = currentNavigatorPlatform()): string {
  const kind = desktopPlatform(platform);
  if (kind === "mac") return "Mac Terminal";
  if (kind === "windows") return "Windows Terminal";
  return "system terminal";
}
