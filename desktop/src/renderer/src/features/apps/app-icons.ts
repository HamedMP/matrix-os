interface IconApp {
  slug: string;
  name: string;
  iconUrl?: string;
}

const MAX_APP_ICON_PRELOADS = 20;
let iconPreloadLinks: HTMLLinkElement[] = [];

export function appIconUrl(platformHost: string, app: string | IconApp, runtimeSlot = "primary"): string | null {
  if (!platformHost) return null;
  const slug = typeof app === "string" ? app : app.slug;
  const iconPath = typeof app === "string" ? undefined : app.iconUrl;
  const url = `${platformHost.replace(/\/$/, "")}${iconPath ?? `/icons/${encodeURIComponent(slug)}.png`}`;
  if (runtimeSlot === "primary") return url;
  return `${url}${url.includes("?") ? "&" : "?"}runtime=${encodeURIComponent(runtimeSlot)}`;
}

export function preloadAppIcons(platformHost: string, runtimeSlot: string, apps: readonly IconApp[]): void {
  clearPreloadedAppIcons();
  if (typeof document === "undefined") return;
  for (const app of apps.slice(0, MAX_APP_ICON_PRELOADS)) {
    const url = appIconUrl(platformHost, app, runtimeSlot);
    if (!url) continue;
    const link = document.createElement("link");
    link.rel = "preload";
    link.setAttribute("as", "image");
    link.setAttribute("fetchpriority", "low");
    link.href = url;
    document.head.append(link);
    iconPreloadLinks.push(link);
  }
}

export function clearPreloadedAppIcons(): void {
  for (const link of iconPreloadLinks) link.remove();
  iconPreloadLinks = [];
}
