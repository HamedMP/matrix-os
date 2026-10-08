import { osViewBundledIconUrlForPath, osViewUsesBundledArtworkForLegacyIcon } from "@matrix-os/contracts";
import { appIconUrl, type MatrixApp } from "../apps/apps.api";
import type { Tab } from "../../stores/tabs";
import icon0 from "../../../../../../shell/public/system-app-icons/v2/chat.png";
import icon1 from "../../../../../../shell/public/system-app-icons/v2/terminal.png";
import icon2 from "../../../../../../shell/public/system-app-icons/v2/files.png";
import icon3 from "../../../../../../shell/public/system-app-icons/v2/editor.png";
import icon4 from "../../../../../../shell/public/system-app-icons/v2/settings.png";
import icon5 from "../../../../../../shell/public/system-app-icons/v2/plugins.png";
import icon6 from "../../../../../../shell/public/system-app-icons/v2/browser.png";
import icon7 from "../../../../../../shell/public/system-app-icons/v2/notes.png";
import icon8 from "../../../../../../shell/public/system-app-icons/v2/whiteboard.png";
import icon9 from "../../../../../../shell/public/system-app-icons/v2/canvas.png";
import icon10 from "../../../../../../shell/public/system-app-icons/v2/desktop.png";
import icon11 from "../../../../../../shell/public/system-app-icons/v2/create-app.png";

const icons: Readonly<Record<string,string>> = {
  "chat": icon0,
  "terminal": icon1,
  "files": icon2,
  "editor": icon3,
  "settings": icon4,
  "plugins": icon5,
  "browser": icon6,
  "notes": icon7,
  "whiteboard": icon8,
  "canvas": icon9,
  "desktop": icon10,
  "create-app": icon11,
};

export function bundledDesktopIconForPath(path: string): string | undefined {
  const url = osViewBundledIconUrlForPath(path);
  if (!url) return undefined;
  return icons[url.slice(url.lastIndexOf("/") + 1, -4)];
}

export function desktopTabsWithLiveAppArtwork(
  tabs: Tab[],
  installedApps: MatrixApp[],
  platformHost: string,
  runtimeSlot: string,
): Tab[] {
  return tabs.map((tab) => {
    const path = tab.kind === "notes" ? "apps/notes/index.html"
      : tab.kind === "app" && tab.slug === "whiteboard" ? "apps/whiteboard/index.html" : undefined;
    const installed = path && installedApps.find((app) => app.path === path);
    if (!path || !installed) return tab;
    const icon = (installed.iconUrl && !osViewUsesBundledArtworkForLegacyIcon({ path, iconUrl: installed.iconUrl })
      ? appIconUrl(platformHost, installed, runtimeSlot) : null)
      ?? bundledDesktopIconForPath(path);
    return icon === tab.icon ? tab : { ...tab, icon };
  });
}
