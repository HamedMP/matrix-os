/**
 * Pure audio codecs for the voice session media layer: base64 framing for
 * `capture.audio`/`response.audio` payloads and float PCM <-> wire PCM
 * conversion. No platform dependencies; safe under jsdom and Node.
 */

const B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_LOOKUP = new Map<string, number>([...B64_ALPHABET].map((char, index) => [char, index]));

export function encodeBase64(bytes: Uint8Array): string {
  let out = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index] as number;
    const b = index + 1 < bytes.length ? (bytes[index + 1] as number) : 0;
    const c = index + 2 < bytes.length ? (bytes[index + 2] as number) : 0;
    out += B64_ALPHABET[a >> 2];
    out += B64_ALPHABET[((a & 0b11) << 4) | (b >> 4)];
    out += index + 1 < bytes.length ? B64_ALPHABET[((b & 0b1111) << 2) | (c >> 6)] : "=";
    out += index + 2 < bytes.length ? B64_ALPHABET[c & 0b11_1111] : "=";
  }
  return out;
}

export function decodeBase64(text: string): Uint8Array | null {
  if (text.length % 4 !== 0) return null;
  const padding = text.endsWith("==") ? 2 : text.endsWith("=") ? 1 : 0;
  const out = new Uint8Array((text.length / 4) * 3 - padding);
  let offset = 0;
  for (let index = 0; index < text.length; index += 4) {
    const a = B64_LOOKUP.get(text[index] as string);
    const b = B64_LOOKUP.get(text[index + 1] as string);
    const cChar = text[index + 2] as string;
    const dChar = text[index + 3] as string;
    const c = cChar === "=" ? 0 : B64_LOOKUP.get(cChar);
    const d = dChar === "=" ? 0 : B64_LOOKUP.get(dChar);
    if (a === undefined || b === undefined || c === undefined || d === undefined) return null;
    if (offset < out.length) out[offset] = (a << 2) | (b >> 4);
    if (offset + 1 < out.length) out[offset + 1] = ((b & 0b1111) << 4) | (c >> 2);
    if (offset + 2 < out.length) out[offset + 2] = ((c & 0b11) << 6) | d;
    offset += 3;
  }
  return out;
}

export function floatToPcm16(samples: Float32Array): Uint8Array {
  const out = new Uint8Array(samples.length * 2);
  const view = new DataView(out.buffer);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index] as number));
    view.setInt16(index * 2, Math.round(sample < 0 ? sample * 32_768 : sample * 32_767), true);
  }
  return out;
}

export function pcm16ToFloat(bytes: Uint8Array): Float32Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Float32Array(Math.floor(bytes.byteLength / 2));
  for (let index = 0; index < out.length; index += 1) {
    out[index] = view.getInt16(index * 2, true) / 32_768;
  }
  return out;
}

export function floatToPcmF32(samples: Float32Array): Uint8Array {
  const out = new Uint8Array(samples.length * 4);
  const view = new DataView(out.buffer);
  for (let index = 0; index < samples.length; index += 1) {
    view.setFloat32(index * 4, samples[index] as number, true);
  }
  return out;
}

export function pcmF32ToFloat(bytes: Uint8Array): Float32Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Float32Array(Math.floor(bytes.byteLength / 4));
  for (let index = 0; index < out.length; index += 1) {
    out[index] = view.getFloat32(index * 4, true);
  }
  return out;
}
