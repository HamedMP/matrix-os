import { describe, it, expect, vi } from "vitest";
import { isAllowedBridgeFetchUrl } from "../../shell/src/components/app-viewer-bridge-policy";
describe("gallery bridge permission", () => {
  it("grants only exact catalog GET and safe install POST to gallery", () => {
    expect(
      isAllowedBridgeFetchUrl("app-gallery", "/api/app-gallery", "GET"),
    ).toBe(true);
    expect(
      isAllowedBridgeFetchUrl(
        "apps/app-gallery",
        "/api/app-gallery/folio/install",
        "POST",
      ),
    ).toBe(true);
    expect(
      isAllowedBridgeFetchUrl("app-gallery", "/api/app-gallery", "POST"),
    ).toBe(false);
    expect(
      isAllowedBridgeFetchUrl(
        "app-gallery",
        "/api/app-gallery/folio/install",
        "GET",
      ),
    ).toBe(false);
    expect(isAllowedBridgeFetchUrl("folio", "/api/app-gallery", "GET")).toBe(
      false,
    );
  });
  it("rejects aliases, queries, traversal, external URLs and unrelated routes", () => {
    for (const url of [
      "/api/app-gallery?x=1",
      "/api/app-gallery#x",
      "/api/app-gallery/",
      "/api/../api/app-gallery",
      "https://bridge.invalid/api/app-gallery",
      "//bridge.invalid/api/app-gallery",
      "/api/app-gallery/%66olio/install",
      "/api/app-gallery/Folio/install",
      "/api/app-gallery/folio/install?x=1",
      "/api/app-gallery/folio/install/",
      "/api/apps/folio",
      "/api/system/activity",
    ])
      expect(isAllowedBridgeFetchUrl("app-gallery", url, "POST")).toBe(false);
  });
  it("retains inventory GET but blocks service execution for gallery", () => {
    expect(
      isAllowedBridgeFetchUrl("app-gallery", "/api/integrations", "GET"),
    ).toBe(true);
    expect(
      isAllowedBridgeFetchUrl("app-gallery", "/api/integrations", "POST"),
    ).toBe(false);
    expect(
      isAllowedBridgeFetchUrl("app-gallery", "/api/integrations?x=1", "GET"),
    ).toBe(false);
  });
});

it.each([2049,4096])("opens a catalog-verified long owner root at %i characters through its manifest identity",async length=>{
 const {resolveAppBridgeLaunch}=await import("../../shell/src/lib/app-bridge-launch");
 const {catalogAppLaunchPath}=await import("../../shell/src/lib/app-catalog-launch");
 const count=Math.ceil((length-4)/256);
 const path="apps/"+Array.from({length:count},(_,i)=>"a".repeat(i===count-1?length-5-(count-1)*256:255)).join("/");
 const row={slug:"folio",name:"Owner Folio",path:`/files/${path}/index.html`};
 vi.stubGlobal("fetch",vi.fn(async()=>new Response(JSON.stringify([row]))));
 try{expect(catalogAppLaunchPath(row)).toBe("apps/folio/index.html");
 await expect(resolveAppBridgeLaunch("Folio","matrix-app:folio",new AbortController().signal)).resolves.toEqual({name:"Owner Folio",path:"apps/folio/index.html"});
 }finally{vi.unstubAllGlobals();}
});
