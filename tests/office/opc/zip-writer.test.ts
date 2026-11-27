import { unzipSync } from "fflate";
import { inflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import {
  FIXED_DOS_DATE,
  FIXED_DOS_TIME,
  buildZip,
  createRecord,
  parseZip,
  readRecord,
} from "../../../packages/office/src/opc/index.js";
import { checksum, handmadeZip, utf8 } from "./handmade-zip.js";

const decoder = new TextDecoder();

function u16(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}

function u32(bytes: Uint8Array, offset: number): number {
  return (u16(bytes, offset) | (u16(bytes, offset + 2) << 16)) >>> 0;
}

describe("createRecord", () => {
  it("deflates compressible content with a correct CRC and a stream any inflater reads", async () => {
    const data = utf8("<w:p><w:r><w:t>text</w:t></w:r></w:p>".repeat(100));
    const record = await createRecord("word/document.xml", data);
    expect(record.method).toBe(8);
    expect(record.compressedSize).toBe(record.compressed.length);
    expect(record.compressed.length).toBeLessThan(data.length / 4);
    expect(record.uncompressedSize).toBe(data.length);
    expect(record.crc32).toBe(checksum(data));
    expect([...inflateRawSync(record.compressed)]).toEqual([...data]);
  });

  it("stores content that deflate cannot shrink, and empty content", async () => {
    const noise = Uint8Array.from({ length: 64 }, (_unused, index) => (index * 197 + 89) % 256);
    const stored = await createRecord("media/image.bin", noise);
    expect(stored.method).toBe(0);
    expect([...stored.compressed]).toEqual([...noise]);
    const empty = await createRecord("empty.xml", new Uint8Array(0));
    expect(empty).toMatchObject({ method: 0, compressedSize: 0, uncompressedSize: 0, crc32: 0 });
  });

  it("stores on request", async () => {
    const data = utf8("a".repeat(500));
    expect((await createRecord("a.txt", data, true)).method).toBe(0);
  });

  it("stamps the fixed timestamp", async () => {
    const record = await createRecord("a.txt", utf8("x"));
    expect(record.dosTime).toBe(FIXED_DOS_TIME);
    expect(record.dosDate).toBe(FIXED_DOS_DATE);
    // 1980-01-01 00:00:00 in MS-DOS form.
    expect([FIXED_DOS_TIME, FIXED_DOS_DATE]).toEqual([0, 0x21]);
  });
});

describe("buildZip", () => {
  it("writes an archive that an independent reader extracts", async () => {
    const files: Record<string, Uint8Array> = {
      "[Content_Types].xml": utf8("<Types/>".repeat(30)),
      "word/document.xml": utf8("<w:document/>".repeat(80)),
      "word/media/image1.png": Uint8Array.from({ length: 90 }, (_unused, index) => (index * 211 + 3) % 256),
      "docs/résumé – 履歴書.txt": utf8("unicode name"),
      "empty.bin": new Uint8Array(0),
    };
    const records = [];
    for (const [name, data] of Object.entries(files)) records.push(await createRecord(name, data));
    const zip = buildZip(records);

    const extracted = unzipSync(zip);
    expect(Object.keys(extracted)).toEqual(Object.keys(files));
    for (const [name, data] of Object.entries(files)) {
      expect([...extracted[name]!]).toEqual([...data]);
    }
    // And the engine's own reader agrees.
    const reread = parseZip(zip).records;
    expect(reread.map((record) => record.name)).toEqual(Object.keys(files));
    for (const record of reread) {
      expect([...(await readRecord(record))]).toEqual([...files[record.name]!]);
    }
  });

  it("is deterministic: the same records give the same bytes", async () => {
    const make = async () =>
      buildZip([
        await createRecord("a.xml", utf8("<a/>".repeat(100))),
        await createRecord("b.xml", utf8("<b/>".repeat(100))),
      ]);
    expect([...(await make())]).toEqual([...(await make())]);
  });

  it("writes plain headers: sizes up front, no data descriptor, no extra field, no comment", async () => {
    const record = await createRecord("a.xml", utf8("<a/>".repeat(100)));
    const zip = buildZip([record]);
    // Local header.
    expect(u32(zip, 0)).toBe(0x04034b50);
    expect(u16(zip, 6)).toBe(0);
    expect(u16(zip, 8)).toBe(8);
    expect(u16(zip, 10)).toBe(FIXED_DOS_TIME);
    expect(u16(zip, 12)).toBe(FIXED_DOS_DATE);
    expect(u32(zip, 14)).toBe(record.crc32);
    expect(u32(zip, 18)).toBe(record.compressedSize);
    expect(u32(zip, 22)).toBe(record.uncompressedSize);
    expect(u16(zip, 28)).toBe(0);
    // The central directory follows the payload directly, and the end record closes the file.
    const directoryOffset = 30 + "a.xml".length + record.compressedSize;
    expect(u32(zip, directoryOffset)).toBe(0x02014b50);
    const end = directoryOffset + 46 + "a.xml".length;
    expect(u32(zip, end)).toBe(0x06054b50);
    expect(u32(zip, end + 16)).toBe(directoryOffset);
    expect(u16(zip, end + 20)).toBe(0);
    expect(zip.length).toBe(end + 22);
  });

  it("flags UTF-8 only for names that need it", async () => {
    const zip = buildZip([await createRecord("plain.txt", utf8("a")), await createRecord("naïve.txt", utf8("b"))]);
    const second = 30 + "plain.txt".length + 1;
    expect(u16(zip, 6) & 0x0800).toBe(0);
    expect(u16(zip, second + 6) & 0x0800).toBe(0x0800);
  });

  it("copies records read from another archive through unchanged, timestamp included", async () => {
    const source = handmadeZip([
      { name: "one.txt", data: "first ".repeat(60), level: 0, dosTime: 0x1111, dosDate: 0x5222, dataDescriptor: true },
      { name: "two.bin", data: Uint8Array.from([9, 8, 7]), method: 0 },
      { name: "three.txt", data: "third ".repeat(60), level: 9, flags: 0x0002 },
    ]);
    const before = parseZip(source).records;
    const after = parseZip(buildZip(before)).records;
    expect(after).toHaveLength(3);
    after.forEach((record, index) => {
      const original = before[index]!;
      expect([...record.compressed]).toEqual([...original.compressed]);
      expect({ ...record, compressed: null }).toEqual({ ...original, compressed: null });
    });
    expect(decoder.decode(await readRecord(after[0]!))).toBe("first ".repeat(60));
  });

  it("writes an empty archive", () => {
    const zip = buildZip([]);
    expect(zip.length).toBe(22);
    expect(parseZip(zip).records).toEqual([]);
  });

  it("refuses an archive it cannot express without ZIP64", () => {
    const record = { name: "x", method: 0 as const, flags: 0, dosTime: 0, dosDate: 0x21, crc32: 0, compressedSize: 0, uncompressedSize: 0, compressed: new Uint8Array(0) };
    const many = Array.from({ length: 0xffff }, (_unused, index) => ({ ...record, name: `e${index}` }));
    expect(() => buildZip(many)).toThrowError(expect.objectContaining({ code: "limit_exceeded" }));
  });
});
