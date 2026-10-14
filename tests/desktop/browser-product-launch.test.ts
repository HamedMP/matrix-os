import { describe, expect, it } from "vitest";
import { browserProductLaunchUrl } from "@desktop/main/embeds/browser-product-launch";

describe("native Browser product launch URL", () => {
  it.each([["matrix-browser", "browser"], ["matrix-cloud-desktop", "desktop"]])("maps only fixed %s identity to its surface", (identity, surface) => {
    const url = new URL(browserProductLaunchUrl("https://gateway.test/apps/browser-lab/?session=synthetic", "browser-lab", identity));
    expect(url.searchParams.get("surface")).toBe(surface);
    expect(url.searchParams.get("session")).toBe("synthetic");
  });
  it.each([["browser-lab", "custom/matrix-browser"], ["notes", "matrix-browser"], ["browser-lab", "browser-lab"]])("leaves unrelated app launch unchanged for %s/%s", (slug, identity) => {
    const url = "https://gateway.test/apps/notes/?session=synthetic";
    expect(browserProductLaunchUrl(url, slug, identity)).toBe(url);
  });
});
