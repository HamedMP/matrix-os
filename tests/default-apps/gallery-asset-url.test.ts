import { describe, expect, it } from "vitest";
import { resolveGalleryAsset } from "../../home/apps/app-gallery/src/artwork";

const moduleUrl = "https://matrix.example/vm/review/apps/app-gallery/assets/index.js?runtime=review&matrix_asset_token=fixture-token&ignored=private";
describe("Gallery artwork in an authenticated sandboxed app frame", () => {
  it("carries only the asset route authorization to bundled sibling artwork", () => {
    const resolved = new URL(resolveGalleryAsset("./folio.png", moduleUrl));
    expect(resolved.pathname).toBe("/vm/review/apps/app-gallery/assets/folio.png");
    expect([...resolved.searchParams]).toEqual([["runtime", "review"], ["matrix_asset_token", "fixture-token"]]);
  });
  it("supports Vite's absolute bundled image URLs without losing the signed module query", () => {
    expect(resolveGalleryAsset("https://matrix.example/vm/review/apps/app-gallery/assets/atlas.png", moduleUrl)).toBe(
      "https://matrix.example/vm/review/apps/app-gallery/assets/atlas.png?runtime=review&matrix_asset_token=fixture-token");
  });
  it.each([
    "https://outside.example/image.png", "https://matrix.example/other/image.png",
    "../private.png", "./nested/image.png", "data:image/png;base64,fixture",
  ])("does not disclose app route credentials to %s", asset => {
    expect(resolveGalleryAsset(asset, moduleUrl)).toBe(asset);
  });
  it("retains direct native and local preview URLs when no route credentials exist", () => {
    expect(resolveGalleryAsset("/src/assets/folio.png", "http://127.0.0.1:3052/src/App.tsx")).toBe("/src/assets/folio.png");
    expect(resolveGalleryAsset("matrix-app://gallery/assets/folio.png", "matrix-app://gallery/assets/index.js")).toBe("matrix-app://gallery/assets/folio.png");
  });
});
