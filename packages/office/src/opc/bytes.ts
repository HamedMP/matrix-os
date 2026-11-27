/** Little-endian byte helpers shared by the ZIP reader and writer. */

const encoder = new TextEncoder();
const strictDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export function readU16(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] as number) | ((bytes[offset + 1] as number) << 8);
}

export function readU32(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] as number) |
      ((bytes[offset + 1] as number) << 8) |
      ((bytes[offset + 2] as number) << 16) |
      ((bytes[offset + 3] as number) << 24)) >>>
    0
  );
}

export function writeU16(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
}

export function writeU32(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 16) & 0xff;
  bytes[offset + 3] = (value >>> 24) & 0xff;
}

export function encodeUtf8(text: string): Uint8Array {
  return encoder.encode(text);
}

/** Strict UTF-8 decode. Returns `null` when the bytes are not valid UTF-8. */
export function tryDecodeUtf8(bytes: Uint8Array): string | null {
  try {
    return strictDecoder.decode(bytes);
  } catch (error) {
    if (error instanceof TypeError) return null;
    throw error;
  }
}

export function isAscii(bytes: Uint8Array): boolean {
  for (let i = 0; i < bytes.length; i++) {
    if ((bytes[i] as number) > 0x7f) return false;
  }
  return true;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** Code page 437 upper half, used for ZIP names that are not flagged UTF-8. */
const CP437_HIGH =
  "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ";

export function decodeCp437(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] as number;
    out += b < 0x80 ? String.fromCharCode(b) : (CP437_HIGH[b - 0x80] as string);
  }
  return out;
}
