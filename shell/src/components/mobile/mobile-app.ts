import type { ShellBootstrapSnapshot } from "@/lib/shell-snapshot-cache";
import { catalogAppLaunchPath } from "@/lib/app-catalog-launch";
import { resolveCatalogIconUrl } from "@/api/apps";
import { nameToSlug } from "@/lib/utils";

export interface MobileApp {
  id: string;
  name: string;
  path: string;
  iconSlug: string;
  iconUrl?: string;
}

export function mobileAppsFromBootstrap(
  bootstrap: ShellBootstrapSnapshot | { name: string; path: string; icon?: string }[] | null | undefined,
): MobileApp[] {
  const list = Array.isArray(bootstrap) ? bootstrap : bootstrap?.apps;
  if (!Array.isArray(list)) return [];
  return list.flatMap((a) => {
    if (typeof a.name !== "string" || typeof a.path !== "string") return [];
    const relative = catalogAppLaunchPath(a);
    if (!relative) return [];
    const iconUrl = resolveCatalogIconUrl("iconUrl" in a ? a.iconUrl : undefined);
    return [{
      id: `app:${relative}`,
      name: a.name,
      path: relative,
      ...(iconUrl ? { iconUrl } : {}),
      iconSlug: a.icon ?? ("slug" in a && typeof a.slug === "string" ? a.slug : nameToSlug(a.name)),
    }];
  });
}

