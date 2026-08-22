import { diagnosticErrorKind } from "./errors";

export function safeUrlTransform(url: string): string {
  try {
    const parsed = new URL(url, "https://matrix.local");
    if (parsed.protocol === "http:" || parsed.protocol === "https:" || parsed.protocol === "mailto:") {
      return url;
    }
  } catch (err: unknown) {
    console.warn("[markdown] ignored invalid URL:", diagnosticErrorKind(err));
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
  } catch (err: unknown) {
    console.warn("[release-notes] ignored invalid URL:", diagnosticErrorKind(err));
    return "";
  }
  return "";
}
