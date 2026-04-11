export function versionedIconUrl(iconUrl: string, etag?: string): string {
  const normalizedEtag = etag?.replace(/"/g, "").trim();
  if (!normalizedEtag) {
    return iconUrl;
  }

  const separator = iconUrl.includes("?") ? "&" : "?";
  return `${iconUrl}${separator}v=${encodeURIComponent(normalizedEtag)}`;
}
