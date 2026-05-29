export function encodeAppSlugPath(slug: string): string {
  return slug
    .split("/")
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}
