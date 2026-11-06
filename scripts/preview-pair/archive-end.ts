/** Bounded final ZIP/ZIP64 directory check. The authenticated archive digest is
 * its integrity authority; this rejects truncation the streaming decoder tolerates. */
export function verifyPreviewZipEnd(tail: Buffer, total: number, entries: number) {
  const bad = () => { throw new Error("Preview archive is unavailable"); };
  let end = -1;
  for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50
    && i + 22 + tail.readUInt16LE(i + 20) === tail.length) { end = i; break; }
  if (end < 0 || tail.readUInt16LE(end + 4) !== 0 || tail.readUInt16LE(end + 6) !== 0) return bad();
  const absolute = total - tail.length + end, count = tail.readUInt16LE(end + 10);
  const size = tail.readUInt32LE(end + 12), offset = tail.readUInt32LE(end + 16);
  if (count !== 0xffff && size !== 0xffffffff && offset !== 0xffffffff
    && count === entries && tail.readUInt16LE(end + 8) === count && offset + size === absolute) return;
  const locator = end - 20;
  if (locator < 0 || tail.readUInt32LE(locator) !== 0x07064b50 || tail.readUInt32LE(locator + 4) !== 0
    || tail.readUInt32LE(locator + 16) !== 1) return bad();
  const recordOffset = tail.readBigUInt64LE(locator + 8), start = Number(recordOffset) - (total - tail.length);
  if (start < 0 || start + 56 > locator || tail.readUInt32LE(start) !== 0x06064b50) return bad();
  const recordSize = tail.readBigUInt64LE(start + 4);
  if (recordSize < 44n || recordSize > 4096n || recordOffset + recordSize + 12n !== BigInt(absolute - 20)
    || tail.readUInt32LE(start + 16) !== 0 || tail.readUInt32LE(start + 20) !== 0
    || tail.readBigUInt64LE(start + 24) !== BigInt(entries) || tail.readBigUInt64LE(start + 32) !== BigInt(entries)
    || tail.readBigUInt64LE(start + 40) + tail.readBigUInt64LE(start + 48) !== recordOffset) return bad();
  // Forced ZIP64 writers may retain the small actual values in the classic
  // footer. They must agree with ZIP64, but need not use saturated sentinels.
  if (count !== 0xffff && count !== entries || tail.readUInt16LE(end + 8) !== 0xffff && tail.readUInt16LE(end + 8) !== entries
    || size !== 0xffffffff && BigInt(size) !== tail.readBigUInt64LE(start + 40)
    || offset !== 0xffffffff && BigInt(offset) !== tail.readBigUInt64LE(start + 48)) return bad();
}
