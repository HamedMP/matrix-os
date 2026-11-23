import { MEDIA_TYPES, type MediaType, mediaTypeForExtension } from "./media.js";

const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

/** `pr-<n>/<commit7>/<26-char base32 of 128 random bits>.<ext>` */
export const EVIDENCE_KEY_PATTERN = /^pr-([1-9][0-9]{0,8})\/([0-9a-f]{7})\/([a-z2-7]{26})\.(png|jpg|webp|gif|mp4|webm|mov)$/;

export function base32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function createEvidenceKey(pr: number, commit: string, contentType: MediaType): string {
  const random = crypto.getRandomValues(new Uint8Array(16));
  return `pr-${pr}/${commit.slice(0, 7).toLowerCase()}/${base32(random)}.${MEDIA_TYPES[contentType]}`;
}

/** Returns the served media type for a valid key, or null when the key is not one this Worker mints. */
export function parseEvidenceKey(key: string): { pr: number; contentType: MediaType } | null {
  const match = EVIDENCE_KEY_PATTERN.exec(key);
  if (!match) return null;
  const contentType = mediaTypeForExtension(match[4]!);
  if (!contentType) return null;
  return { pr: Number(match[1]), contentType };
}
