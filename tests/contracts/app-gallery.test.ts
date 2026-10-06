import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { AppGalleryCatalogSchema, deriveGalleryReadiness, filterGalleryApps } from "../../packages/contracts/src/app-gallery.js";
import { getAction } from "../../packages/gateway/src/integrations/registry.js";

const catalog = async () => AppGalleryCatalogSchema.parse(JSON.parse(await readFile(new URL("../../home/system/app-gallery.json", import.meta.url), "utf8")));

describe("curated gallery contract", () => {
  it("offers 12 distinct personal and 12 business apps backed by real read actions", async () => {
    const { apps } = await catalog();
    expect(apps.filter(a => a.collection === "personal")).toHaveLength(12);
    expect(apps.filter(a => a.collection === "business")).toHaveLength(12);
    expect(new Set(apps.map(a => a.id)).size).toBe(24);
    for (const app of apps) for (const service of app.services) for (const action of service.actions) {
      expect(getAction(service.id, action), `${app.id}: ${service.id}/${action}`).toMatchObject({ risk: "read" });
    }
  });
  it("rejects duplicate ids and unsafe ids", async () => {
    const data = await catalog();
    expect(AppGalleryCatalogSchema.safeParse({ ...data, apps: [data.apps[0], data.apps[0]] }).success).toBe(false);
    expect(AppGalleryCatalogSchema.safeParse({ ...data, apps: [{ ...data.apps[0], id: "../escape" }] }).success).toBe(false);
  });
  it("does not confuse missing inventory with a disconnected account", async () => {
    const app = (await catalog()).apps.find(a => a.id === "folio")!;
    expect(deriveGalleryReadiness(app, null).status).toBe("unknown");
    expect(deriveGalleryReadiness(app, []).status).toBe("needs_connection");
    expect(deriveGalleryReadiness(app, [{ service: "gmail", account_label: "Work", status: "connected" }]).status).toBe("ready");
    expect(deriveGalleryReadiness(app, [{ service: "gmail", account_label: "Work", status: "disconnected" }]).status).toBe("needs_connection");
    const multiple = deriveGalleryReadiness(app, [{ service: "gmail", account_label: "Work", status: "connected" }, { service: "gmail", account_label: "Personal", status: "connected" }]);
    expect(multiple.status).toBe("choose_accounts");
    expect(multiple.services[0].accounts).toHaveLength(2);
  });
  it("allows local apps without a connection and filters from one shared derivation", async () => {
    const { apps } = await catalog();
    expect(deriveGalleryReadiness(apps.find(a => a.id === "habits")!, null).status).toBe("ready");
    expect(filterGalleryApps(apps, { collection: "business", query: "Stripe" }).map(a => a.id)).toContain("revenue");
    expect(filterGalleryApps(apps, { collection: "personal", query: "unlikely-no-result" })).toEqual([]);
  });
});
