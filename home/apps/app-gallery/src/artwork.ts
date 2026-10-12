/** Keep sandboxed artwork on the same authenticated route as its bundled module. */
export function resolveGalleryAsset(asset: string, moduleUrl: string): string {
  const module = new URL(moduleUrl);
  if (!module.searchParams.has("matrix_asset_token")) return asset;
  const url = new URL(asset, module);
  const directory = module.pathname.slice(0, module.pathname.lastIndexOf("/") + 1);
  if (url.origin !== module.origin || url.pathname.slice(0, url.pathname.lastIndexOf("/") + 1) !== directory) return asset;
  for (const key of ["runtime", "matrix_asset_token"]) {
    const value = module.searchParams.get(key);
    if (value !== null) url.searchParams.set(key, value);
  }
  return url.href;
}

// Importing artwork lets Vite package it under /assets/, where the sandboxed
// app's read-only signed route applies. Public-folder paths cannot use that route.
const images = import.meta.glob<string>("./assets/**/*.{png,svg}", {
  eager: true, query: "?url", import: "default",
});

export function galleryArtwork(path: string): string | undefined {
  const asset = images[`./assets/${path}`];
  return asset === undefined ? undefined : resolveGalleryAsset(asset, import.meta.url);
}

/** Keep each app's semantic identity when newer artwork cannot be loaded. */
export function galleryIdentitySources(app: { id: string; icon: string }): string[] {
  return [`icons/${app.id}.png`, `clay/${app.id}.svg`, `icons/${app.icon}.svg`]
    .map(galleryArtwork)
    .filter((asset): asset is string => asset !== undefined)
    .filter((asset, index, assets) => assets.indexOf(asset) === index);
}
