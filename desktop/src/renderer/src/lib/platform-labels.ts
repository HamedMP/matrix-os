import { currentNavigatorPlatform, desktopPlatform } from "./desktop-platform";

export function desktopShortcutLabel(keys: string, platform = currentNavigatorPlatform()): string {
  return `${desktopPlatform(platform) === "mac" ? "⌘" : "Ctrl+"}${keys}`;
}

export function systemTerminalLabel(platform = currentNavigatorPlatform()): string {
  const kind = desktopPlatform(platform);
  if (kind === "mac") return "Mac Terminal";
  if (kind === "windows") return "Windows Terminal";
  return "system terminal";
}
