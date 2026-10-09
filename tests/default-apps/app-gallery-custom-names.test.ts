import { describe, expect, it, vi } from "vitest";
import catalog from "../../home/system/app-gallery.json";
import { installGalleryApp, parseListing, visibleApps } from "../../home/apps/app-gallery/src/model";

describe("existing owner app name projections", () => {
  it.each([81, 200, 1000])("preserves the gallery when an existing app has a %i-character name", async length => {
    const name = "Owner app ".padEnd(length, "x");
    const app = { ...catalog.apps[0], installed: true, installedName: name, launchPath: `apps/${catalog.apps[0].id}` };
    const parsed = parseListing({ version: 1, apps: [app] });
    expect(parsed[0].installedName).toBe(name.slice(0, 200));
    const bridge = { gatewayFetch: vi.fn().mockResolvedValue({ status: "already_installed", slug: app.id, name, path: app.launchPath }) };
    const installed = await installGalleryApp(bridge, app.id);
    expect(installed.name).toBe(name.slice(0, 200));
    expect(installed.path).toBe(app.launchPath);
    expect(app.installedName).toBe(name);
  });
});

it("searches owner names and catalog names with the same installed collection filters", () => {
 const app = {...catalog.apps.find(app => app.id === 'folio')!, installed:true, installedName:'My Receipts'};
 for(const query of ['my receipts','Folio']) expect(visibleApps([app],{collection:'personal',query,category:'',readiness:'installed'},null)).toEqual([app]);
 expect(visibleApps([app],{collection:'business',query:'My Receipts',category:'',readiness:'installed'},null)).toEqual([]);
});
