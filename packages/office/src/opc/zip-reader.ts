/**
 * ZIP container reader.
 *
 * `parseZip` is synchronous and inflates nothing: it walks the end-of-central-
 * directory record, the central directory and every local header, and applies
 * the entry-count and declared-size limits there. `readRecord` inflates one
 * entry and never produces more bytes than that entry declared.
 */

import { bytesEqual, decodeCp437, readU16, readU32, tryDecodeUtf8 } from "./bytes.js";
import { crc32 } from "./crc32.js";
import { InflateFailure, inflateRaw } from "./deflate.js";
import { fault } from "./errors.js";
import type { ZipLimits } from "../api/opc.js";
import { resolveZipLimits } from "./limits.js";
import { assertSafeEntryName, entryNameKey } from "./entry-names.js";
import {
  CENTRAL_FIXED,
  EOCD_FIXED,
  FLAG_DEFLATE_HINT,
  FLAG_ENCRYPTED,
  FLAG_MASKED_HEADERS,
  FLAG_PATCHED,
  FLAG_STRONG_ENCRYPTION,
  FLAG_UTF8,
  LOCAL_FIXED,
  MAX_COMMENT,
  METHOD_DEFLATE,
  METHOD_STORED,
  SIG_CENTRAL,
  SIG_EOCD,
  SIG_LOCAL,
  SIG_ZIP64_LOCATOR,
  U16_MAX,
  U32_MAX,
  ZIP64_LOCATOR_SIZE,
  type ZipRecord,
} from "./zip-format.js";

interface EndRecord {
  readonly offset: number;
  readonly entryCount: number;
  readonly directorySize: number;
  readonly directoryOffset: number;
}

interface CentralEntry {
  readonly name: string;
  readonly nameBytes: Uint8Array;
  readonly method: 0 | 8;
  readonly flags: number;
  readonly dosTime: number;
  readonly dosDate: number;
  readonly crc32: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly localOffset: number;
}

function findEndRecord(bytes: Uint8Array): EndRecord {
  if (bytes.length < EOCD_FIXED) {
    throw fault("not_zip", "file is too short to be a ZIP archive");
  }
  const lowest = Math.max(0, bytes.length - EOCD_FIXED - MAX_COMMENT);
  let fallback = -1;
  let found = -1;
  for (let at = bytes.length - EOCD_FIXED; at >= lowest; at--) {
    if (bytes[at] !== 0x50 || readU32(bytes, at) !== SIG_EOCD) continue;
    const end = at + EOCD_FIXED + readU16(bytes, at + 20);
    if (end === bytes.length) {
      found = at;
      break;
    }
    if (end < bytes.length && fallback < 0) fallback = at;
  }
  if (found < 0) found = fallback;
  if (found < 0) {
    throw fault("not_zip", "end of central directory record not found");
  }

  const diskNumber = readU16(bytes, found + 4);
  const directoryDisk = readU16(bytes, found + 6);
  const entriesOnDisk = readU16(bytes, found + 8);
  const entryCount = readU16(bytes, found + 10);
  const directorySize = readU32(bytes, found + 12);
  const directoryOffset = readU32(bytes, found + 16);

  const hasLocator =
    found >= ZIP64_LOCATOR_SIZE && readU32(bytes, found - ZIP64_LOCATOR_SIZE) === SIG_ZIP64_LOCATOR;
  if (
    hasLocator ||
    diskNumber === U16_MAX ||
    directoryDisk === U16_MAX ||
    entriesOnDisk === U16_MAX ||
    entryCount === U16_MAX ||
    directorySize === U32_MAX ||
    directoryOffset === U32_MAX
  ) {
    throw fault("zip64", "ZIP64 archives are not supported");
  }
  if (diskNumber !== 0 || directoryDisk !== 0 || entriesOnDisk !== entryCount) {
    throw fault("multi_disk", "multi-disk ZIP archives are not supported");
  }
  if (directoryOffset + directorySize > found) {
    throw fault("corrupt_zip", "central directory lies outside the archive");
  }
  return { offset: found, entryCount, directorySize, directoryOffset };
}

function decodeName(nameBytes: Uint8Array, flags: number): string {
  const utf8 = tryDecodeUtf8(nameBytes);
  if (utf8 !== null) return utf8;
  if (flags & FLAG_UTF8) {
    throw fault("corrupt_zip", "entry name is flagged UTF-8 but is not valid UTF-8");
  }
  return decodeCp437(nameBytes);
}

function assertNotEncrypted(flags: number, method: number): void {
  if (flags & (FLAG_ENCRYPTED | FLAG_STRONG_ENCRYPTION | FLAG_MASKED_HEADERS) || method === 99) {
    throw fault("encrypted", "encrypted ZIP archives are not supported");
  }
}

function readCentralEntry(bytes: Uint8Array, at: number, directoryEnd: number): { entry: CentralEntry; next: number } {
  if (at + CENTRAL_FIXED > directoryEnd || readU32(bytes, at) !== SIG_CENTRAL) {
    throw fault("corrupt_zip", "central directory entry is malformed");
  }
  const flags = readU16(bytes, at + 8);
  const method = readU16(bytes, at + 10);
  const dosTime = readU16(bytes, at + 12);
  const dosDate = readU16(bytes, at + 14);
  const crc = readU32(bytes, at + 16);
  const compressedSize = readU32(bytes, at + 20);
  const uncompressedSize = readU32(bytes, at + 24);
  const nameLength = readU16(bytes, at + 28);
  const extraLength = readU16(bytes, at + 30);
  const commentLength = readU16(bytes, at + 32);
  const diskStart = readU16(bytes, at + 34);
  const localOffset = readU32(bytes, at + 42);
  const next = at + CENTRAL_FIXED + nameLength + extraLength + commentLength;
  if (next > directoryEnd) {
    throw fault("corrupt_zip", "central directory entry runs past the directory");
  }

  assertNotEncrypted(flags, method);
  if (
    compressedSize === U32_MAX ||
    uncompressedSize === U32_MAX ||
    localOffset === U32_MAX ||
    diskStart === U16_MAX
  ) {
    throw fault("zip64", "ZIP64 archives are not supported");
  }
  if (diskStart !== 0) {
    throw fault("multi_disk", "multi-disk ZIP archives are not supported");
  }
  if ((method !== METHOD_STORED && method !== METHOD_DEFLATE) || flags & FLAG_PATCHED) {
    throw fault("unsupported_compression", `compression method ${method} is not supported`);
  }
  if (method === METHOD_STORED && compressedSize !== uncompressedSize) {
    throw fault("corrupt_zip", "stored entry has different compressed and uncompressed sizes");
  }

  const nameBytes = bytes.subarray(at + CENTRAL_FIXED, at + CENTRAL_FIXED + nameLength);
  const name = decodeName(nameBytes, flags);
  assertSafeEntryName(name);
  return {
    entry: { name, nameBytes, method, flags, dosTime, dosDate, crc32: crc, compressedSize, uncompressedSize, localOffset },
    next,
  };
}

/** Returns the offset of the entry payload after checking its local header. */
function locatePayload(bytes: Uint8Array, entry: CentralEntry, directoryOffset: number): number {
  const at = entry.localOffset;
  if (at + LOCAL_FIXED > directoryOffset || readU32(bytes, at) !== SIG_LOCAL) {
    throw fault("corrupt_zip", `local header of "${entry.name}" is missing`);
  }
  const flags = readU16(bytes, at + 6);
  const method = readU16(bytes, at + 8);
  assertNotEncrypted(flags, method);
  if (readU32(bytes, at + 18) === U32_MAX || readU32(bytes, at + 22) === U32_MAX) {
    throw fault("zip64", "ZIP64 archives are not supported");
  }
  if (method !== entry.method) {
    throw fault("corrupt_zip", `local header of "${entry.name}" disagrees with the central directory`);
  }
  const nameLength = readU16(bytes, at + 26);
  const extraLength = readU16(bytes, at + 28);
  const nameStart = at + LOCAL_FIXED;
  const payload = nameStart + nameLength + extraLength;
  if (payload + entry.compressedSize > directoryOffset) {
    throw fault("corrupt_zip", `data of "${entry.name}" runs past the central directory`);
  }
  if (!bytesEqual(bytes.subarray(nameStart, nameStart + nameLength), entry.nameBytes)) {
    throw fault("corrupt_zip", `local header of "${entry.name}" names a different entry`);
  }
  return payload;
}

function assertNoOverlap(spans: { start: number; end: number; name: string }[]): void {
  spans.sort((a, b) => a.start - b.start);
  for (let i = 1; i < spans.length; i++) {
    const previous = spans[i - 1] as { start: number; end: number; name: string };
    const current = spans[i] as { start: number; end: number; name: string };
    if (current.start < previous.end) {
      throw fault("corrupt_zip", `entries "${previous.name}" and "${current.name}" overlap`);
    }
  }
}

/**
 * Parses the container structure without inflating anything.
 * Entries are returned in central directory order.
 */
export function parseZip(bytes: Uint8Array, limitsInput?: Partial<ZipLimits>): { records: ZipRecord[]; limits: ZipLimits } {
  const limits = resolveZipLimits(limitsInput);
  const end = findEndRecord(bytes);
  if (end.entryCount > limits.maxEntries) {
    throw fault("too_many_entries", `archive has ${end.entryCount} entries; the limit is ${limits.maxEntries}`, { limit: "maxEntries" });
  }

  const directoryEnd = end.directoryOffset + end.directorySize;
  // Bounded: at most `limits.maxEntries` names, checked above.
  const seen = new Set<string>();
  const records: ZipRecord[] = [];
  const spans: { start: number; end: number; name: string }[] = [];
  let declaredTotal = 0;
  let at = end.directoryOffset;
  for (let index = 0; index < end.entryCount; index++) {
    const { entry, next } = readCentralEntry(bytes, at, directoryEnd);
    at = next;

    const key = entryNameKey(entry.name);
    if (seen.has(key)) {
      throw fault("duplicate_entry", `archive contains "${entry.name}" more than once`);
    }
    seen.add(key);

    if (entry.uncompressedSize > limits.maxEntryBytes) {
      throw fault("entry_too_large", `"${entry.name}" declares ${entry.uncompressedSize} bytes; the limit is ${limits.maxEntryBytes}`, { limit: "maxEntryBytes" });
    }
    declaredTotal += entry.uncompressedSize;
    if (declaredTotal > limits.maxTotalBytes) {
      throw fault("archive_too_large", `archive declares more than ${limits.maxTotalBytes} bytes of content`, { limit: "maxTotalBytes" });
    }

    const payload = locatePayload(bytes, entry, end.directoryOffset);
    spans.push({ start: entry.localOffset, end: payload + entry.compressedSize, name: entry.name });
    records.push({
      name: entry.name,
      method: entry.method,
      flags: entry.flags & FLAG_DEFLATE_HINT,
      dosTime: entry.dosTime,
      dosDate: entry.dosDate,
      crc32: entry.crc32,
      compressedSize: entry.compressedSize,
      uncompressedSize: entry.uncompressedSize,
      compressed: bytes.subarray(payload, payload + entry.compressedSize),
    });
  }
  assertNoOverlap(spans);
  return { records, limits };
}

/**
 * Returns the uncompressed content of one entry as a fresh array. Inflation
 * stops at the declared size, which `parseZip` already held to the limits, and
 * the result is checked against the declared size and CRC-32.
 */
export async function readRecord(record: ZipRecord): Promise<Uint8Array> {
  let data: Uint8Array;
  if (record.method === METHOD_STORED) {
    data = record.compressed.slice();
  } else {
    try {
      data = await inflateRaw(record.compressed, record.uncompressedSize);
    } catch (error) {
      if (!(error instanceof InflateFailure)) throw error;
      if (error.kind === "too-large") {
        throw fault("size_mismatch", `"${record.name}" inflates past its declared size of ${record.uncompressedSize} bytes`);
      }
      if (error.kind === "unsupported") {
        throw fault("compression_stream_unavailable", error.message);
      }
      throw fault("corrupt_zip", `"${record.name}" could not be inflated`, undefined, error);
    }
  }
  if (data.length !== record.uncompressedSize) {
    throw fault("size_mismatch", `"${record.name}" has ${data.length} bytes but declares ${record.uncompressedSize}`);
  }
  if (crc32(data) !== record.crc32) {
    throw fault("crc_mismatch", `"${record.name}" fails its CRC-32 check`);
  }
  return data;
}
