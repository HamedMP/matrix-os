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

export function safeReleaseNotesUrlTransform(url: string): string {
  try {
    const parsed = new URL(url);
    if (
      parsed.protocol === "https:" &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.toString().length <= 2048
    ) {
      return url;
    }
  } catch {
    return "";
  }
  return "";
}
