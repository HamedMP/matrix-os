/**
 * URL rules for mail content. Links may use http, https and mailto. Images may
 * use http, https, cid and base64 raster data. Everything else, including every
 * relative URL, is refused: a mail has no base address of its own.
 */

export const MAX_URL_LENGTH = 8192;
export const MAX_CONTENT_ID_LENGTH = 512;
export const DEFAULT_MAX_INLINE_IMAGE_BYTES = 2 * 1024 * 1024;

/** Raster formats a browser decodes without running anything. SVG is not one of them. */
const RASTER_SUBTYPES: ReadonlyMap<string, string> = new Map([
  ["png", "png"],
  ["x-png", "png"],
  ["jpeg", "jpeg"],
  ["jpg", "jpeg"],
  ["pjpeg", "jpeg"],
  ["gif", "gif"],
  ["webp", "webp"],
  ["bmp", "bmp"],
  ["avif", "avif"],
]);

export type ImageSource =
  | { kind: "remote"; url: string }
  | { kind: "data"; url: string }
  | { kind: "cid"; id: string }
  /** `local` is true for a data or cid reference that was refused. */
  | { kind: "invalid"; local: boolean };

function errorName(error: unknown): string {
  return typeof error === "object" && error !== null && "name" in error ? String((error as { name: unknown }).name) : "";
}

/** Applies the URL parser's own clean-up, so the scheme we check is the scheme a browser sees. */
export function normalizeUrlInput(raw: string): string {
  return raw.replace(/[\t\n\r]/g, "").replace(/^[\u0000-\u0020]+|[\u0000-\u0020]+$/g, "");
}

function parseAbsoluteUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch (error) {
    // The URL parser answers "not an absolute URL" with a TypeError; anything else is a real fault.
    if (errorName(error) === "TypeError") return null;
    throw error;
  }
}

function schemeOf(value: string): string | null {
  const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(value);
  return match ? match[1].toLowerCase() : null;
}

/** Characters that must not appear in a URL written into an attribute. The URL parser encodes them where it can. */
const UNSAFE_IN_ATTRIBUTE = /[<>"`\s\u0000-\u001F\u007F]/;

function safeWebUrl(value: string): string | null {
  const url = parseAbsoluteUrl(value);
  if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) return null;
  if (!url.hostname || url.username || url.password || UNSAFE_IN_ATTRIBUTE.test(url.href)) return null;
  return url.href;
}

/** The canonical form of a link target, or null when the link must not be followed. */
export function safeLinkUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > MAX_URL_LENGTH) return null;
  let value = normalizeUrlInput(raw);
  if (value.startsWith("//")) value = `https:${value}`;
  const scheme = schemeOf(value);
  if (scheme === "http" || scheme === "https") return safeWebUrl(value);
  if (scheme !== "mailto") return null;
  const url = parseAbsoluteUrl(value);
  if (!url || url.protocol !== "mailto:" || !url.pathname.includes("@") || UNSAFE_IN_ATTRIBUTE.test(url.href)) return null;
  return url.href;
}

/** A remote image address (http or https), in canonical form, or null. */
export function safeRemoteImageUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > MAX_URL_LENGTH) return null;
  let value = normalizeUrlInput(raw);
  if (value.startsWith("//")) value = `https:${value}`;
  const scheme = schemeOf(value);
  return scheme === "http" || scheme === "https" ? safeWebUrl(value) : null;
}

/** Decoded size of a base64 payload that has no whitespace. */
export function base64ByteLength(payload: string): number {
  const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
  return Math.floor((payload.length * 3) / 4) - padding;
}

/**
 * Accepts only `data:image/<raster>;base64,<payload>` up to `maxBytes` decoded,
 * and returns it rebuilt from its checked parts.
 */
export function safeDataImageUrl(raw: unknown, maxBytes: number = DEFAULT_MAX_INLINE_IMAGE_BYTES): string | null {
  if (typeof raw !== "string") return null;
  // Four base64 characters carry three bytes; anything longer than this cannot be under the cap.
  if (raw.length > Math.ceil((maxBytes * 4) / 3) + 4096) return null;
  const value = raw.replace(/\s+/g, "");
  const match = /^data:image\/([a-z0-9.+-]{1,20});base64,([A-Za-z0-9+/]+={0,2})$/i.exec(value);
  if (!match) return null;
  const subtype = RASTER_SUBTYPES.get(match[1].toLowerCase());
  if (!subtype || base64ByteLength(match[2]) > maxBytes) return null;
  return `data:image/${subtype};base64,${match[2]}`;
}

/** The raster subtype (`png`, `jpeg`, ...) for an image MIME type, or null. */
export function rasterSubtype(mimeType: unknown): string | null {
  if (typeof mimeType !== "string") return null;
  const match = /^\s*image\/([a-z0-9.+-]{1,20})\s*(?:;|$)/i.exec(mimeType);
  return match ? RASTER_SUBTYPES.get(match[1].toLowerCase()) ?? null : null;
}

/** Strips the angle brackets and surrounding space from a Content-ID. */
export function normalizeContentId(raw: string): string {
  return raw.trim().replace(/^<+|>+$/g, "").trim();
}

function decodeContentId(encoded: string): string {
  try {
    return decodeURIComponent(encoded);
  } catch (error) {
    // A stray percent sign is common in generated ids; use the text as written.
    if (errorName(error) === "URIError") return encoded;
    throw error;
  }
}

/** Sorts an `<img src>` value into the kinds the sanitiser handles. */
export function classifyImageSource(raw: unknown, maxBytes: number = DEFAULT_MAX_INLINE_IMAGE_BYTES): ImageSource {
  if (typeof raw !== "string") return { kind: "invalid", local: false };
  const value = normalizeUrlInput(raw);
  if (/^cid:/i.test(value)) {
    const id = normalizeContentId(decodeContentId(value.slice(4)));
    return id && id.length <= MAX_CONTENT_ID_LENGTH ? { kind: "cid", id } : { kind: "invalid", local: true };
  }
  if (/^data:/i.test(value)) {
    const url = safeDataImageUrl(value, maxBytes);
    return url ? { kind: "data", url } : { kind: "invalid", local: true };
  }
  const url = safeRemoteImageUrl(value);
  return url ? { kind: "remote", url } : { kind: "invalid", local: false };
}
