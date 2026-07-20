const platformShellAssetPrefix = process.env.NEXT_PUBLIC_PLATFORM_SHELL_ASSET_PREFIX ?? "";

export function platformShellAssetPath(path: `/${string}`): string {
  return `${platformShellAssetPrefix}${path}`;
}
