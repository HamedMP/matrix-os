import { describe, expect, it } from "vitest";
import { desktopTabsWithLiveAppArtwork } from "@desktop/renderer/src/features/desktop-shell/bundled-app-icons";
import type { Tab } from "@desktop/renderer/src/stores/tabs";

const tab: Tab = { id: "2048-tab", kind: "app", slug: "2048", title: "2048", appIdentity: "games/2048", closable: true };
const app = { slug: "2048", name: "2048", appIdentity: "games/2048", path: "apps/games/2048/index.html", iconUrl: "/icons/2048.png?v=current" };

describe("live installed-app artwork", () => {
  it("reconciles restored app tabs against the selected catalog icon and runtime without mutating saved tabs", () => {
    const projected = desktopTabsWithLiveAppArtwork([tab], [app], "https://runtime.example.com", "secondary");
    expect(projected[0]?.icon).toBe("https://runtime.example.com/icons/2048.png?v=current&runtime=secondary");
    expect(tab.icon).toBeUndefined();
    expect(projected[0]?.id).toBe(tab.id);
    expect(desktopTabsWithLiveAppArtwork(projected, [app], "https://runtime.example.com", "secondary")[0]).toBe(projected[0]);
    expect(desktopTabsWithLiveAppArtwork(projected, [{ ...app, iconUrl: "/icons/2048.png?v=new" }], "https://runtime.example.com", "secondary")[0]?.icon).toContain("?v=new&runtime=secondary");
  });

  it("uses a unique slug for legacy tabs and refuses ambiguous or mismatched app identities", () => {
    const legacy = { ...tab, appIdentity: undefined };
    expect(desktopTabsWithLiveAppArtwork([legacy], [app], "https://runtime.example.com", "primary")[0]?.icon).toContain("/icons/2048.png?v=current");
    const other = { ...app, appIdentity: "custom/2048", iconUrl: "/icons/custom.png?v=owner" };
    expect(desktopTabsWithLiveAppArtwork([legacy], [app, other], "https://runtime.example.com", "primary")[0]).toBe(legacy);
    expect(desktopTabsWithLiveAppArtwork([tab], [other], "https://runtime.example.com", "primary")[0]).toBe(tab);
    expect(desktopTabsWithLiveAppArtwork([tab], [], "https://runtime.example.com", "primary")[0]).toBe(tab);
  });
});
