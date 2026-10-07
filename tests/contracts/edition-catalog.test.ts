import { describe, expect, it } from "vitest";
import catalog from "../../home/system/app-gallery.json";
import { AppGalleryCatalogSchema } from "../../packages/contracts/src/app-gallery";
import { isAppGalleryInventoryIdentity } from "../../packages/contracts/src/app-gallery-bridge-policy";
describe("Edition catalog identity", () => {
  it("registers a scoped reading app in the canonical portable gallery", () => {
    const parsed = AppGalleryCatalogSchema.parse(catalog);
    const app = parsed.apps.find((a) => a.id === "edition");
    expect(app).toMatchObject({
      name: "Edition",
      collection: "personal",
      view: "library",
      icon: "edition",
    });
    expect(app?.services).toEqual([
      { id: "gmail", name: "Gmail", actions: ["search", "get_message"] },
    ]);
    expect(isAppGalleryInventoryIdentity("edition")).toBe(true);
    expect(isAppGalleryInventoryIdentity("edition", "copied-edition")).toBe(
      false,
    );
  });
});
