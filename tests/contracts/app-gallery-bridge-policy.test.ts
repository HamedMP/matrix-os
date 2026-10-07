import { expect, it } from "vitest";
import { APP_GALLERY_STARTER_IDENTITIES, isAppGalleryInventoryIdentity } from "../../packages/contracts/src/app-gallery-bridge-policy";
import catalog from "../../home/system/app-gallery.json";

it("binds native inventory capabilities to the exact canonical catalog identities", () => {
  expect([...APP_GALLERY_STARTER_IDENTITIES].sort()).toEqual(catalog.apps.map((app) => app.id).sort());
  expect(isAppGalleryInventoryIdentity("app-gallery", "app-gallery")).toBe(true);
  for (const app of catalog.apps) {
    expect(isAppGalleryInventoryIdentity(app.id, app.id)).toBe(true);
    expect(isAppGalleryInventoryIdentity(`custom/${app.id}`, app.id)).toBe(false);
    expect(isAppGalleryInventoryIdentity(app.id, "other")).toBe(false);
  }
});
