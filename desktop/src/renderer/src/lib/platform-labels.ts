function currentPlatform(): string {
  return typeof navigator === "undefined" ? "" : navigator.platform;
}

function isMacPlatform(platform: string): boolean {
  return /^(Mac|iPhone|iPad|iPod)/i.test(platform);
}

export function desktopShortcutLabel(keys: string, platform = currentPlatform()): string {
  return `${isMacPlatform(platform) ? "⌘" : "Ctrl+"}${keys}`;
}

export function systemTerminalLabel(platform = currentPlatform()): string {
  if (isMacPlatform(platform)) return "Mac Terminal";
  if (/^Win/i.test(platform)) return "Windows Terminal";
  return "system terminal";
}
