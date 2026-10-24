import { BOT_INPUT_FILE_MAX_BYTES } from "#bots/broker";
/** Shared admission/composer policy for the existing Pi native image and artifact transports. */
export const BOT_INPUT_IMAGE_MAX_BYTES = 2 * 1024 * 1024;
export const BOT_INPUT_IMAGE_TOTAL_MAX_BYTES = 8 * 1024 * 1024;
export const BOT_INPUT_TOTAL_MAX_BYTES = 20 * 1024 * 1024;
export const BOT_INPUT_MAX_IMAGES = 4;
export const BOT_INPUT_MAX_ATTACHMENTS = 8;
/** Conservative base64 budget beneath the funded Relay's existing 2MiB whole-body cap. */
export const BOT_FUNDED_IMAGE_TOTAL_MAX_BYTES = 1024 * 1024;
export const BOT_ATTACHMENT_UNAVAILABLE_MESSAGE = "Attachments could not be read. Reattach files up to 10 MiB or PNG/JPEG/WebP images up to 2 MiB; 20 MiB total. Your model/source may require smaller images.";
export type BotAttachmentMetadata = { kind: string; mimeType?: string; sizeBytes?: number };
export function botAttachmentInputError(parts: readonly BotAttachmentMetadata[], vision: boolean, imageTotalMaximum = BOT_INPUT_IMAGE_TOTAL_MAX_BYTES): string | null {
  if (parts.length > BOT_INPUT_MAX_ATTACHMENTS) return "Attach up to eight files per message.";
  const images = parts.filter(part => part.kind === "image");
  if (images.length && !vision) return "The selected model does not support images.";
  if (images.length > BOT_INPUT_MAX_IMAGES) return "Attach up to four images per message.";
  if (images.some(part => !["image/png", "image/jpeg", "image/webp"].includes(part.mimeType ?? ""))) return "Use PNG, JPEG or WebP images for this model.";
  if (images.some(part => (part.sizeBytes ?? 0) > BOT_INPUT_IMAGE_MAX_BYTES)) return "Images must be 2 MiB or smaller for this model.";
  if (images.reduce((sum, part) => sum + (part.sizeBytes ?? 0), 0) > imageTotalMaximum) return "Images for this Matrix AI source must total 1 MiB or less.";
  if (parts.some(part => part.kind !== "image" && part.kind !== "file")) return "This model supports uploaded images and files only.";
  if (parts.some(part => part.kind === "file" && (part.sizeBytes ?? 0) > BOT_INPUT_FILE_MAX_BYTES)) return "Files must be 10 MiB or smaller for this model.";
  if (parts.reduce((sum, part) => sum + (part.sizeBytes ?? 0), 0) > BOT_INPUT_TOTAL_MAX_BYTES) return "Attachments must total 20 MiB or less.";
  return null;
}
/** MIME signatures for the three existing native image formats; full decoding stays with the provider. */
export function botNativeImageMime(bytes: Uint8Array): "image/png" | "image/jpeg" | "image/webp" | undefined {
  const png = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length >= png.length && png.every((byte, index) => bytes[index] === byte)) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  if (bytes.length >= 12 && String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF" && String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP") return "image/webp";
  return undefined;
}

/** Known managed identities; catalog metadata never grants or changes execution authority. */
export function botImageTotalMaximumForSelection(instanceId: string, options?: readonly { id: string; value: string | boolean }[]): number {
  return instanceId === "matrix_pi_default" || (instanceId === "matrix_bot_default" && !options?.length)
    ? BOT_FUNDED_IMAGE_TOTAL_MAX_BYTES : BOT_INPUT_IMAGE_TOTAL_MAX_BYTES;
}
