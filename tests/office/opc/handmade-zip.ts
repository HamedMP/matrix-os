/**
 * Builds ZIP archives byte by byte, independently of the engine's writer, so
 * reader tests do not depend on the code they check. Every header field can be
 * overridden to produce the malformed and hostile archives the reader must refuse.
 */

import { deflateRawSync } from "node:zlib";

import { crc32 as nodeCrc32 } from "node:zlib";

export interface HandmadeEntry {
  name: string | Uint8Array;
  /** Uncompressed content. */
  data?: Uint8Array | string;
  /** 0 stored, 8 deflate (default 8 unless `data` is empty). Any other value is written as given. */
  method?: number;
  /** zlib level for deflate entries; level 0 gives a stream no compressor would produce again. */
  level?: number;
  flags?: number;
  /** Writes zeros in the local header and a data descriptor after the payload. */
  dataDescriptor?: boolean;
  dosTime?: number;
  dosDate?: number;
  /** Overrides for lying or damaged headers. */
  crc?: number;
  compressedSize?: number;
  uncompressedSize?: number;
  localOffset?: number;
  localName?: string | Uint8Array;
  localMethod?: number;
  diskStart?: number;
  /** Bytes used as the payload instead of compressing `data`. */
  rawPayload?: Uint8Array;
  localExtra?: Uint8Array;
  centralExtra?: Uint8Array;
  comment?: Uint8Array;
}

export interface HandmadeOptions {
  comment?: Uint8Array;
  /** Bytes inserted before the end-of-central-directory record. */
  beforeEnd?: Uint8Array;
  diskNumber?: number;
  directoryDisk?: number;
  entriesOnDisk?: number;
  entryCount?: number;
  directoryOffset?: number;
  directorySize?: number;
}

const encoder = new TextEncoder();

export function utf8(text: string): Uint8Array {
  return encoder.encode(text);
}

function toBytes(value: Uint8Array | string | undefined): Uint8Array {
  if (value === undefined) return new Uint8Array(0);
  return typeof value === "string" ? utf8(value) : value;
}

function u16(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff];
}

function u32(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}

export function concat(...chunks: (Uint8Array | number[])[]): Uint8Array {
  const arrays = chunks.map((chunk) => (chunk instanceof Uint8Array ? chunk : Uint8Array.from(chunk)));
  const out = new Uint8Array(arrays.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of arrays) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

export function checksum(data: Uint8Array): number {
  return nodeCrc32(data) >>> 0;
}

export function rawDeflate(data: Uint8Array, level = 6): Uint8Array {
  return new Uint8Array(deflateRawSync(data, { level }));
}

export function handmadeZip(entries: HandmadeEntry[], options: HandmadeOptions = {}): Uint8Array {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const data = toBytes(entry.data);
    const method = entry.method ?? (data.length === 0 ? 0 : 8);
    const payload = entry.rawPayload ?? (method === 8 ? rawDeflate(data, entry.level) : data);
    const nameBytes = toBytes(entry.name);
    const hasNonAscii = nameBytes.some((byte) => byte > 0x7f);
    const flags = entry.flags ?? ((entry.dataDescriptor ? 0x0008 : 0) | (hasNonAscii ? 0x0800 : 0));
    const crc = entry.crc ?? checksum(data);
    const compressedSize = entry.compressedSize ?? payload.length;
    const uncompressedSize = entry.uncompressedSize ?? data.length;
    const dosTime = entry.dosTime ?? 0x6b2c;
    const dosDate = entry.dosDate ?? 0x5a21;
    const localName = toBytes(entry.localName ?? nameBytes);
    const localExtra = entry.localExtra ?? new Uint8Array(0);
    const centralExtra = entry.centralExtra ?? new Uint8Array(0);
    const comment = entry.comment ?? new Uint8Array(0);
    const deferred = entry.dataDescriptor === true;

    const local = concat(
      u32(0x04034b50),
      u16(20),
      u16(flags),
      u16(entry.localMethod ?? method),
      u16(dosTime),
      u16(dosDate),
      u32(deferred ? 0 : crc),
      u32(deferred ? 0 : compressedSize),
      u32(deferred ? 0 : uncompressedSize),
      u16(localName.length),
      u16(localExtra.length),
      localName,
      localExtra,
      payload,
      deferred ? concat(u32(0x08074b50), u32(crc), u32(payload.length), u32(data.length)) : [],
    );
    centrals.push(
      concat(
        u32(0x02014b50),
        u16(0x031e),
        u16(20),
        u16(flags),
        u16(method),
        u16(dosTime),
        u16(dosDate),
        u32(crc),
        u32(compressedSize),
        u32(uncompressedSize),
        u16(nameBytes.length),
        u16(centralExtra.length),
        u16(comment.length),
        u16(entry.diskStart ?? 0),
        u16(0),
        u32(0x81a40000),
        u32(entry.localOffset ?? offset),
        nameBytes,
        centralExtra,
        comment,
      ),
    );
    locals.push(local);
    offset += local.length;
  }

  const directory = concat(...centrals);
  const comment = options.comment ?? new Uint8Array(0);
  return concat(
    ...locals,
    directory,
    options.beforeEnd ?? [],
    u32(0x06054b50),
    u16(options.diskNumber ?? 0),
    u16(options.directoryDisk ?? 0),
    u16(options.entriesOnDisk ?? entries.length),
    u16(options.entryCount ?? entries.length),
    u32(options.directorySize ?? directory.length),
    u32(options.directoryOffset ?? offset),
    u16(comment.length),
    comment,
  );
}

export const CONTENT_TYPES_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n' +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Default Extension="png" ContentType="image/png"/>' +
  '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
  '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
  "</Types>";

export const ROOT_RELS_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
  "</Relationships>";

export const DOCUMENT_RELS_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
  '<Relationship Id="rId7" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/>' +
  '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/a?b=1&amp;c=2" TargetMode="External"/>' +
  "</Relationships>";

export const DOCUMENT_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n' +
  '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
  "<w:p><w:r><w:t>Hello, package.</w:t></w:r></w:p>".repeat(40) +
  "</w:body></w:document>";

export const STYLES_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n' +
  '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
  '<w:style w:type="paragraph" w:styleId="Normal"><w:name w:val="Normal"/></w:style>'.repeat(20) +
  "</w:styles>";

/** Stand-in image bytes: not compressible, so writers store them. */
export const IMAGE_BYTES = Uint8Array.from({ length: 300 }, (_unused, index) => (index * 151 + 17) % 256);

/**
 * A small word-processing package in the entry order a desktop producer
 * writes. The parts use different deflate levels, a stored entry, a data
 * descriptor and a directory entry, so writing one back unchanged can only
 * match byte for byte by reusing the stored bytes.
 */
export function handmadeDocx(): Uint8Array {
  return handmadeZip([
    { name: "[Content_Types].xml", data: CONTENT_TYPES_XML, level: 9, dataDescriptor: true },
    { name: "_rels/.rels", data: ROOT_RELS_XML, level: 1 },
    { name: "word/", data: "" },
    { name: "word/document.xml", data: DOCUMENT_XML, level: 0, dosTime: 0x1234, dosDate: 0x5b6f },
    { name: "word/_rels/document.xml.rels", data: DOCUMENT_RELS_XML, level: 9 },
    { name: "word/styles.xml", data: STYLES_XML, level: 1, flags: 0x0006 },
    { name: "word/media/image1.png", data: IMAGE_BYTES, method: 0 },
    { name: "customXml/item1.bin", data: "unknown part the engine does not understand", level: 2 },
  ]);
}
