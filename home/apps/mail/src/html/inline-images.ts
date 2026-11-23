/**
 * Inline (`cid:`) images. A mail refers to an attached image by its Content-ID;
 * the app fetches the attachment and hands the sanitiser a data URL for it.
 * Data URLs are used rather than blob URLs because the mail renders in a frame
 * with its own origin, which cannot read the app's blob URLs.
 */
import { base64ByteLength, DEFAULT_MAX_INLINE_IMAGE_BYTES, normalizeContentId, rasterSubtype } from "./url-policy";

export interface InlineImageSource {
  /** The attachment's Content-ID, with or without angle brackets. */
  contentId?: string;
  /** The attachment's file name; used when the provider gives no Content-ID. */
  name?: string;
  /** From `attachmentToDataUrl`. The sanitiser checks it again. */
  dataUrl: string;
}

export interface AttachmentBytes {
  mimeType: string;
  /** Base64, standard or URL-safe, with or without padding. */
  contentBase64: string;
}

export type CidResolver = (contentId: string) => string | null;

/**
 * Builds a data URL for an attachment when it is a raster image under the cap.
 * Returns null for every other type, including SVG, and for malformed base64.
 */
export function attachmentToDataUrl(content: AttachmentBytes, maxBytes: number = DEFAULT_MAX_INLINE_IMAGE_BYTES): string | null {
  const subtype = rasterSubtype(content?.mimeType);
  if (!subtype || typeof content.contentBase64 !== "string") return null;
  if (content.contentBase64.length > Math.ceil((maxBytes * 4) / 3) + 4096) return null;
  let payload = content.contentBase64.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  if (!payload || !/^[A-Za-z0-9+/]+$/.test(payload) || payload.length % 4 === 1) return null;
  payload += "=".repeat((4 - (payload.length % 4)) % 4);
  if (base64ByteLength(payload) > maxBytes) return null;
  return `data:image/${subtype};base64,${payload}`;
}

function key(value: string): string {
  return normalizeContentId(value).toLowerCase();
}

/**
 * Looks a `cid:` reference up by Content-ID first, then by file name. Some
 * senders write the id as `<file name>@<suffix>`, so the part before the `@`
 * is tried as a file name too.
 */
export function createCidResolver(sources: readonly InlineImageSource[]): CidResolver {
  const byId = new Map<string, string>();
  const byName = new Map<string, string>();
  for (const source of sources) {
    if (!source || typeof source.dataUrl !== "string") continue;
    if (source.contentId && !byId.has(key(source.contentId))) byId.set(key(source.contentId), source.dataUrl);
    if (source.name && !byName.has(key(source.name))) byName.set(key(source.name), source.dataUrl);
  }
  return (contentId) => {
    const wanted = key(contentId);
    const at = wanted.indexOf("@");
    return byId.get(wanted) ?? byName.get(wanted) ?? (at > 0 ? byName.get(wanted.slice(0, at)) : undefined) ?? null;
  };
}
