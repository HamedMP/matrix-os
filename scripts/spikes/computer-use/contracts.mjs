import { z } from 'zod/v4';
import { crc32, inflateSync } from 'node:zlib';
export const DISPLAY = ':7';
export const IMAGE_LIMIT = 2 * 1024 * 1024;
const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
export const Grant = z.object({
  ownerId: id, chatId: id, runId: id, targetId: z.string().regex(/^pv-[1-9][0-9]{0,8}-[a-f0-9]{8}$/),
  display: z.literal(DISPLAY), modelRoute: id, syntheticOnly: z.literal(true),
  expiresAt: z.number().int().positive(),
}).strict();
// Separate trusted experiment grant; the Preview contract above remains unchanged.
export const MainIsolatedGrant = Grant.omit({ targetId: true }).extend({
  scope: z.literal('main-isolated'), runtimeSlot: z.literal('primary'), targetId: id,
}).strict();
const grounded = { actionId: id, observationId: id, leaseEpoch: z.number().int().positive(), geometryRevision: z.number().int().positive() };
const coordinate = z.number().int().min(0).max(1599);
const point = z.object({ x: coordinate, y: coordinate }).strict();
export const Action = z.discriminatedUnion('action', [
  z.object({ action: z.literal('status') }).strict(),
  z.object({ action: z.literal('observe') }).strict(),
  z.object({ action: z.literal('click'), ...grounded, x: coordinate, y: coordinate }).strict(),
  z.object({ action: z.literal('drag'), ...grounded, points: z.array(point).min(2).max(120), durationMs: z.number().int().min(1).max(2000) }).strict(),
  z.object({ action: z.literal('scroll'), ...grounded, x: coordinate, y: coordinate, direction: z.enum(['up','down']), ticks: z.number().int().min(1).max(20) }).strict(),
  z.object({ action: z.literal('type'), ...grounded, text: z.string().min(1).max(4000).regex(/^[\x20-\x7e]+$/) }).strict(),
  z.object({ action: z.literal('key'), ...grounded, keys: z.array(z.string().regex(/^(?:[A-Z0-9]|CTRL|ALT|SHIFT|RETURN|ESC|TAB|SPACE|BACKSPACE|DELETE|HOME|END|LEFT|RIGHT|UP|DOWN|PAGEUP|PAGEDOWN)$/)).min(1).max(8) }).strict(),
]);
export function validateFrame(frame) {
  if (!frame || typeof frame.data !== 'string' || frame.data.length > Math.ceil(IMAGE_LIMIT / 3) * 4) throw new Error('invalid_image');
  const bytes = Buffer.from(frame.data, 'base64');
  if (bytes.length > IMAGE_LIMIT || bytes.length < 33 || bytes.toString('base64') !== frame.data ||
    !bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) || bytes.toString('ascii',12,16) !== 'IHDR') throw new Error('invalid_image');
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  if (width < 1 || height < 1 || width > 1600 || height > 1600 || frame.width !== width || frame.height !== height) throw new Error('invalid_image');
  // A header alone is not an image observation. Qualify the bounded, noninterlaced
  // eight-bit PNG formats used by mss and synthetic fixtures, including pixels.
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[bytes[25]];
  if (bytes.readUInt32BE(8) !== 13 || bytes[24] !== 8 || !channels || bytes[26] || bytes[27] || bytes[28]) throw new Error('invalid_image');
  const compressed = []; // <=256 PNG chunks, total <=IMAGE_LIMIT.
  let offset = 8, count = 0, ended = false;
  while (offset + 12 <= bytes.length && count++ < 256) {
    const length = bytes.readUInt32BE(offset), end = offset + length + 12;
    if (end > bytes.length || crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) throw new Error('invalid_image');
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    if (type === 'IHDR') {
      if (offset !== 8 || length !== 13) throw new Error('invalid_image');
    } else if (type === 'IDAT') compressed.push(bytes.subarray(offset + 8, end - 4));
    else if (type === 'IEND') {
      if (length || end !== bytes.length || !compressed.length) throw new Error('invalid_image');
      ended = true; break;
    } else throw new Error('invalid_image');
    offset = end;
  }
  if (!ended) throw new Error('invalid_image');
  const stride = width * channels + 1, expected = height * stride;
  const pixels = inflateSync(Buffer.concat(compressed), { maxOutputLength: expected });
  if (pixels.length !== expected) throw new Error('invalid_image');
  for (let row = 0; row < height; row++) if (pixels[row * stride] > 4) throw new Error('invalid_image');
  return { width, height, data: frame.data };
}
