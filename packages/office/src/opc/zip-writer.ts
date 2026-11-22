/**
 * ZIP container writer.
 *
 * `buildZip` lays out already-compressed records in the order given. It writes
 * no data descriptors, no extra fields and no comments, and never reads the
 * clock, so the same records always produce the same bytes. A record that came
 * from `parseZip` carries its original payload, method, CRC-32 and timestamp
 * and is copied through unchanged; a record made by `createRecord` carries a
 * fixed timestamp.
 */

import { encodeUtf8, isAscii, writeU16, writeU32 } from "./bytes.js";
import { crc32 } from "./crc32.js";
import { InflateFailure, deflateRaw } from "./deflate.js";
import { fault } from "./errors.js";
import {
  CENTRAL_FIXED,
  EOCD_FIXED,
  FIXED_DOS_DATE,
  FIXED_DOS_TIME,
  FLAG_DEFLATE_HINT,
  FLAG_UTF8,
  LOCAL_FIXED,
  METHOD_DEFLATE,
  METHOD_STORED,
  SIG_CENTRAL,
  SIG_EOCD,
  SIG_LOCAL,
  U16_MAX,
  U32_MAX,
  VERSION_MADE_BY,
  VERSION_NEEDED,
  type ZipRecord,
} from "./zip-format.js";

/**
 * Compresses `data` into a record. DEFLATE is used unless `store` is set or
 * the deflated form would not be smaller than the content.
 */
export async function createRecord(name: string, data: Uint8Array, store = false): Promise<ZipRecord> {
  if (data.length >= U32_MAX) {
    throw fault("archive_not_writable", `"${name}" is too large for a ZIP entry without ZIP64`);
  }
  const checksum = crc32(data);
  if (!store && data.length > 0) {
    let deflated: Uint8Array;
    try {
      deflated = await deflateRaw(data);
    } catch (error) {
      if (error instanceof InflateFailure && error.kind === "unsupported") {
        throw fault("compression_stream_unavailable", error.message);
      }
      throw error;
    }
    if (deflated.length < data.length) {
      return {
        name,
        method: METHOD_DEFLATE,
        flags: 0,
        dosTime: FIXED_DOS_TIME,
        dosDate: FIXED_DOS_DATE,
        crc32: checksum,
        compressedSize: deflated.length,
        uncompressedSize: data.length,
        compressed: deflated,
      };
    }
  }
  return {
    name,
    method: METHOD_STORED,
    flags: 0,
    dosTime: FIXED_DOS_TIME,
    dosDate: FIXED_DOS_DATE,
    crc32: checksum,
    compressedSize: data.length,
    uncompressedSize: data.length,
    compressed: data,
  };
}

interface Prepared {
  readonly record: ZipRecord;
  readonly nameBytes: Uint8Array;
  readonly flags: number;
}

/** Serializes records, in the order given, into one ZIP archive. */
export function buildZip(records: readonly ZipRecord[]): Uint8Array {
  if (records.length >= U16_MAX) {
    throw fault("archive_not_writable", "archive has too many entries to write without ZIP64");
  }
  const prepared: Prepared[] = [];
  let localSize = 0;
  let directorySize = 0;
  for (const record of records) {
    const nameBytes = encodeUtf8(record.name);
    if (nameBytes.length > U16_MAX) {
      throw fault("invalid_part_name", "entry name is too long");
    }
    const flags = (record.flags & FLAG_DEFLATE_HINT) | (isAscii(nameBytes) ? 0 : FLAG_UTF8);
    prepared.push({ record, nameBytes, flags });
    localSize += LOCAL_FIXED + nameBytes.length + record.compressed.length;
    directorySize += CENTRAL_FIXED + nameBytes.length;
  }
  if (localSize + directorySize >= U32_MAX) {
    throw fault("archive_not_writable", "archive is too large to write without ZIP64");
  }

  const out = new Uint8Array(localSize + directorySize + EOCD_FIXED);
  const offsets: number[] = [];
  let at = 0;
  for (const { record, nameBytes, flags } of prepared) {
    offsets.push(at);
    writeU32(out, at, SIG_LOCAL);
    writeU16(out, at + 4, VERSION_NEEDED);
    writeU16(out, at + 6, flags);
    writeU16(out, at + 8, record.method);
    writeU16(out, at + 10, record.dosTime);
    writeU16(out, at + 12, record.dosDate);
    writeU32(out, at + 14, record.crc32);
    writeU32(out, at + 18, record.compressed.length);
    writeU32(out, at + 22, record.uncompressedSize);
    writeU16(out, at + 26, nameBytes.length);
    writeU16(out, at + 28, 0);
    out.set(nameBytes, at + LOCAL_FIXED);
    out.set(record.compressed, at + LOCAL_FIXED + nameBytes.length);
    at += LOCAL_FIXED + nameBytes.length + record.compressed.length;
  }

  const directoryOffset = at;
  prepared.forEach(({ record, nameBytes, flags }, index) => {
    writeU32(out, at, SIG_CENTRAL);
    writeU16(out, at + 4, VERSION_MADE_BY);
    writeU16(out, at + 6, VERSION_NEEDED);
    writeU16(out, at + 8, flags);
    writeU16(out, at + 10, record.method);
    writeU16(out, at + 12, record.dosTime);
    writeU16(out, at + 14, record.dosDate);
    writeU32(out, at + 16, record.crc32);
    writeU32(out, at + 20, record.compressed.length);
    writeU32(out, at + 24, record.uncompressedSize);
    writeU16(out, at + 28, nameBytes.length);
    // extra length, comment length, disk start, internal and external attributes stay zero
    writeU32(out, at + 42, offsets[index] as number);
    out.set(nameBytes, at + CENTRAL_FIXED);
    at += CENTRAL_FIXED + nameBytes.length;
  });

  writeU32(out, at, SIG_EOCD);
  writeU16(out, at + 8, prepared.length);
  writeU16(out, at + 10, prepared.length);
  writeU32(out, at + 12, directorySize);
  writeU32(out, at + 16, directoryOffset);
  return out;
}
