import { nativeBrowserProduct } from "../../shared/browser-products";

export function browserProductLaunchUrl(launchUrl: string, slug: string, identity: string): string {
  const product = nativeBrowserProduct(identity, slug);
  if (!product) return launchUrl;
  const url = new URL(launchUrl);
  if (url.pathname !== "/apps/browser-lab/" || url.username || url.password) throw new Error("invalid browser launch");
  url.searchParams.set("surface", product.surface);
  return url.toString();
}
