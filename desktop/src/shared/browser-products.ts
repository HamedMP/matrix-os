export const BROWSER_PRODUCTS = {
  "matrix-browser": { surface: "browser", path: "__browser__", name: "Browser" },
  "matrix-cloud-desktop": { surface: "desktop", path: "__cloud-desktop__", name: "Cloud desktop" },
} as const;

export function nativeBrowserProduct(appIdentity: string, routeSlug: string) {
  if (routeSlug !== "browser-lab") return null;
  return appIdentity === "matrix-browser" || appIdentity === "matrix-cloud-desktop"
    ? BROWSER_PRODUCTS[appIdentity] : null;
}
