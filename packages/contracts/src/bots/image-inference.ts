import { BOT_INPUT_IMAGE_MAX_BYTES, BOT_INPUT_MAX_IMAGES, BOT_INPUT_TOTAL_MAX_BYTES, botNativeImageMime } from "#bots/input-policy";
/** Keep text limits unchanged; only recognized native image blocks receive extra budget. */
export const BOT_INFERENCE_TEXT_MAX_BYTES = 256 * 1024;
export const BOT_IMAGE_INFERENCE_MAX_BYTES = Math.ceil(BOT_INPUT_TOTAL_MAX_BYTES / 3) * 4 + BOT_INFERENCE_TEXT_MAX_BYTES + 4096;
export const BOT_IMAGE_INFERENCE_FRAME_MAX_BYTES = BOT_IMAGE_INFERENCE_MAX_BYTES + BOT_INFERENCE_TEXT_MAX_BYTES + 4096;
const encoder = new TextEncoder();
const mimeTypes = ["image/png", "image/jpeg", "image/webp"];
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
function keys(value: Record<string, unknown>, allowed: string[]) { return Object.keys(value).every(key => allowed.includes(key)); }
/** Returns counts only; never returns submitted bytes or model text. */
export function validateBotImageInferenceBody(body: string, maximumTextBytes = BOT_INFERENCE_TEXT_MAX_BYTES): { valid: boolean; imageCount: number } {
  if (body.length > BOT_IMAGE_INFERENCE_MAX_BYTES || encoder.encode(body).byteLength > BOT_IMAGE_INFERENCE_MAX_BYTES) return { valid: false, imageCount: 0 };
  try {
    const value: unknown = JSON.parse(body); if (!record(value)) return { valid: false, imageCount: 0 };
    let imageCount = 0, totalBytes = 0, imageCharacters = 0, nodes = 0;
    const replacements = new Map<object, unknown>(); // local only: max four recognized images.
    const data = (encoded: unknown, mime: unknown) => {
      if (typeof encoded !== "string" || typeof mime !== "string" || !mimeTypes.includes(mime)
        || encoded.length < 4 || encoded.length > Math.ceil(BOT_INPUT_IMAGE_MAX_BYTES / 3) * 4
        || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw new Error("Invalid image");
      const prefix = atob(encoded.slice(0, 16));
      if (botNativeImageMime(Uint8Array.from(prefix, char => char.charCodeAt(0))) !== mime) throw new Error("Image MIME");
      const length = encoded.length / 4 * 3 - (encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0);
      totalBytes += length; imageCharacters += encoded.length; imageCount++;
      if (length > BOT_INPUT_IMAGE_MAX_BYTES || totalBytes > BOT_INPUT_TOTAL_MAX_BYTES || imageCount > BOT_INPUT_MAX_IMAGES) throw new Error("Image capacity");
    };
    const messages = Array.isArray(value.input) ? value.input : Array.isArray(value.messages) ? value.messages : [];
    for (const message of messages) {
      if (!record(message) || !Array.isArray(message.content)) continue;
      for (const part of message.content) {
        if (!record(part) || !["image", "image_url", "input_image"].includes(String(part.type))) continue;
        if (message.role !== "user") throw new Error("Image role");
        if (part.type === "image") {
          if (!keys(part, ["type", "source", "cache_control"]) || !record(part.source) || part.source.type !== "base64" || !keys(part.source, ["type", "media_type", "data"])) throw new Error("Image shape");
          if (part.cache_control !== undefined && (!record(part.cache_control) || !keys(part.cache_control, ["type", "ttl"]) || part.cache_control.type !== "ephemeral" || (part.cache_control.ttl !== undefined && !["5m", "1h"].includes(String(part.cache_control.ttl))))) throw new Error("Image cache shape");
          data(part.source.data, part.source.media_type);
          replacements.set(part, { ...part, source: { ...part.source, data: "" } });
        } else {
          let url: unknown;
          if (part.type === "input_image") {
            if (!keys(part, ["type", "image_url", "detail"])) throw new Error("Image shape"); url = part.image_url;
          } else {
            if (!keys(part, ["type", "image_url"]) || !record(part.image_url) || !keys(part.image_url, ["url", "detail"])) throw new Error("Image shape"); url = part.image_url.url;
          }
          const detail = part.type === "input_image" ? part.detail : (part.image_url as Record<string, unknown>).detail;
          if (detail !== undefined && !["auto", "high", "low"].includes(String(detail))) throw new Error("Image detail");
          if (typeof url !== "string") throw new Error("Image URL");
          const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(url);
          if (!match) throw new Error("Remote or invalid image"); data(match[2], match[1]);
          replacements.set(part, part.type === "input_image" ? { ...part, image_url: "" } : { ...part, image_url: { ...(part.image_url as object), url: "" } });
        }
      }
    }
    function bounded(current: unknown, depth: number): unknown {
      if (++nodes > 32768 || depth > 24) throw new Error("Input nesting");
      if (Array.isArray(current)) return current.map(child => bounded(child, depth + 1));
      if (!record(current)) return current;
      const replacement = replacements.get(current);
      if (replacement) return replacement;
      if (["image", "image_url", "input_image"].includes(String(current.type))) throw new Error("Unknown image shape");
      return Object.fromEntries(Object.entries(current).map(([key, child]) => [key, bounded(child, depth + 1)]));
    }
    const text = JSON.stringify(bounded(value, 0));
    const textMaximum = Math.min(maximumTextBytes, 512000);
    return { valid: encoder.encode(text).byteLength <= textMaximum && encoder.encode(body).byteLength - imageCharacters <= textMaximum, imageCount };
  } catch (error: unknown) {
    if (!(error instanceof Error)) throw error;
    return { valid: false, imageCount: 0 };
  }
}
