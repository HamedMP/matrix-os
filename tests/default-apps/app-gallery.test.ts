import { describe, it, expect, vi } from "vitest";
import catalog from "../../home/system/app-gallery.json";
import {
  visibleApps,
  loadGallery,
  installGalleryApp,
  openGalleryApp,
  parseListing,
} from "../../home/apps/app-gallery/src/model";
const apps = catalog.apps.map((app) => ({ ...app, installed: false }));
describe("app gallery", () => {
  it("filters collection, search, category and live readiness together", () => {
    expect(
      visibleApps(
        apps as never,
        {
          collection: "personal",
          query: "Gmail",
          category: "",
          readiness: "all",
        },
        null,
      ).every((a) => a.collection === "personal"),
    ).toBe(true);
    expect(
      visibleApps(
        apps as never,
        {
          collection: "personal",
          query: "",
          category: "",
          readiness: "unknown",
        },
        null,
      ).length,
    ).toBeGreaterThan(0);
    expect(
      visibleApps(
        apps as never,
        {
          collection: "personal",
          query: "",
          category: "",
          readiness: "needs_connection",
        },
        [],
      ).every((a) => a.services.length > 0),
    ).toBe(true);
  });
  it("unavailable inventory stays unknown without blocking catalog", async () => {
    const result = await loadGallery({
      gatewayFetch: vi.fn().mockResolvedValue({ version: 1, apps }),
      integrations: vi.fn().mockRejectedValue(new Error("private failure")),
    });
    expect(result.apps).toHaveLength(31);
    expect(result.connections).toBeNull();
  });
  it("keeps exact account labels and detects multiple accounts", async () => {
    const rows = [
      {
        service: "gmail",
        status: "active",
        account_label: "Work - Finna",
        account_email: "one@example.com",
      },
      {
        service: "gmail",
        status: "active",
        account_label: "Personal",
        account_email: "two@example.com",
      },
    ];
    const result = await loadGallery({
      gatewayFetch: vi.fn().mockResolvedValue({ version: 1, apps }),
      integrations: vi.fn().mockResolvedValue(rows),
    });
    expect(result.connections).toEqual(rows);
    expect(
      visibleApps(
        result.apps,
        {
          collection: "personal",
          query: "Folio",
          category: "",
          readiness: "choose_accounts",
        },
        result.connections,
      ),
    ).toHaveLength(1);
  });
  it("fails catalog safely when unavailable or invalid", async () => {
    await expect(
      loadGallery({
        gatewayFetch: vi.fn().mockResolvedValue({ error: "private db path" }),
        integrations: vi.fn().mockResolvedValue([]),
      }),
    ).rejects.toThrow("Gallery unavailable");
    expect(() =>
      parseListing({ version: 1, apps: [{ ...apps[0], id: "../evil" }] }),
    ).toThrow();
  });
  it("accepts the canonical forty-app limit while rejecting larger listings", () => {
    const bounded = Array.from({ length: 40 }, (_, index) => ({ ...apps[0], id: `boundary-${index}` }));
    expect(parseListing({ version: 1, apps: bounded })).toHaveLength(40);
    expect(() => parseListing({ version: 1, apps: [...bounded, { ...apps[0], id: "boundary-40" }] })).toThrow("Gallery unavailable");
  });
  it("installs through the exact owner endpoint and opens the returned app", async () => {
    const result = {
      status: "installed",
      slug: "folio",
      name: "Folio",
      path: "apps/folio",
    };
    const bridge = {
      gatewayFetch: vi.fn().mockResolvedValue(result),
      openApp: vi.fn(),
    };
    expect(await installGalleryApp(bridge, "folio")).toEqual(result);
    expect(bridge.gatewayFetch).toHaveBeenCalledWith(
      "/api/app-gallery/folio/install",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      },
      35000,
    );
    await openGalleryApp(bridge, {
      ...apps[0],
      installed: true,
      launchPath: result.path,
    } as never);
    expect(bridge.openApp).toHaveBeenCalledWith("Folio", "apps/folio");
  });
  it("rejects an installation result that points at another app", async () => {
    const bridge = {gatewayFetch: vi.fn().mockResolvedValue({status:'installed',slug:'folio',name:'Folio',path:'apps/other'})};
    await expect(installGalleryApp(bridge,'folio')).rejects.toThrow('Installation unavailable');
    expect(() => parseListing({version:1,apps:[{...apps[0],installed:true,launchPath:'apps/other'}]})).toThrow('Gallery unavailable');
  });
  it("failed installation remains retryable; unsafe ids never call bridge", async () => {
    const bridge = {
      gatewayFetch: vi
        .fn()
        .mockRejectedValueOnce(new Error("provider secret"))
        .mockResolvedValueOnce({
          status: "already_installed",
          slug: "folio",
          name: "Folio",
          path: "apps/folio",
        }),
    };
    await expect(installGalleryApp(bridge, "folio")).rejects.toThrow(
      "Installation unavailable",
    );
    expect((await installGalleryApp(bridge, "folio")).status).toBe(
      "already_installed",
    );
    await expect(installGalleryApp(bridge, "../folio")).rejects.toThrow(
      "Installation unavailable",
    );
    expect(bridge.gatewayFetch).toHaveBeenCalledTimes(2);
  });
});
