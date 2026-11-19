export type DesktopPlatform = "mac" | "windows" | "linux";

export function currentNavigatorPlatform(): string {
  return typeof navigator === "undefined" ? "" : navigator.platform;
}

export function desktopPlatform(platform = currentNavigatorPlatform()): DesktopPlatform {
  if (/^(Mac|iPhone|iPad|iPod)/i.test(platform)) return "mac";
  if (/^Win/i.test(platform)) return "windows";
  return "linux";
}
