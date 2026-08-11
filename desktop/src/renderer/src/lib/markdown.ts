export function safeUrlTransform(url: string): string {
  try {
    const parsed = new URL(url, "https://matrix.local");
    if (parsed.protocol === "http:" || parsed.protocol === "https:" || parsed.protocol === "mailto:") {
      return url;
    }
  } catch {
    return "";
  }
  return "";
}
