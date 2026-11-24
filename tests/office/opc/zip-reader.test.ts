import { describe, expect, it } from "vitest";

import { isOfficeError } from "../../../packages/office/src/errors.js";
import { crc32, parseZip, readRecord } from "../../../packages/office/src/opc/index.js";
import { checksum, concat, handmadeZip, rawDeflate, utf8 } from "./handmade-zip.js";

const decoder = new TextDecoder();

function failure(action: () => unknown): { code: string; reason: unknown } {
  try {
    action();
  } catch (error) {
    if (isOfficeError(error)) return { code: error.code, reason: error.details.reason };
    throw error;
  }
  throw new Error("expected the archive to be refused");
}

async function asyncFailure(action: () => Promise<unknown>): Promise<{ code: string; reason: unknown }> {
  try {
    await action();
  } catch (error) {
    if (isOfficeError(error)) return { code: error.code, reason: error.details.reason };
    throw error;
  }
  throw new Error("expected the entry to be refused");
}

describe("crc32", () => {
  it("matches the reference check value and the platform implementation", () => {
    expect(crc32(utf8("123456789"))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array(0))).toBe(0);
    const data = Uint8Array.from({ length: 5000 }, (_unused, index) => (index * 31) % 256);
    expect(crc32(data)).toBe(checksum(data));
    expect(crc32(data.subarray(2000), crc32(data.subarray(0, 2000)))).toBe(checksum(data));
  });
});

describe("parseZip on hand-built archives", () => {
  it("reads stored and deflated entries in central directory order", async () => {
    const text = "deflate me ".repeat(200);
    const zip = handmadeZip([
      { name: "a/stored.bin", data: Uint8Array.from([1, 2, 3, 4, 5]), method: 0 },
      { name: "b/deflated.txt", data: text },
      { name: "empty.txt", data: "" },
    ]);
    const { records } = parseZip(zip);
    expect(records.map((record) => record.name)).toEqual(["a/stored.bin", "b/deflated.txt", "empty.txt"]);
    expect(records.map((record) => record.method)).toEqual([0, 8, 0]);
    expect(records[1]?.uncompressedSize).toBe(text.length);
    expect(records[1]?.compressedSize).toBeLessThan(text.length);
    expect(records[1]?.crc32).toBe(checksum(utf8(text)));
    expect([...(await readRecord(records[0]!))]).toEqual([1, 2, 3, 4, 5]);
    expect(decoder.decode(await readRecord(records[1]!))).toBe(text);
    expect((await readRecord(records[2]!)).length).toBe(0);
  });

  it("takes sizes and CRC from the central directory when the local header defers to a data descriptor", async () => {
    const text = "streamed entry ".repeat(50);
    const zip = handmadeZip([
      { name: "first.txt", data: text, dataDescriptor: true },
      { name: "second.txt", data: "after the descriptor", method: 0, dataDescriptor: true },
    ]);
    const { records } = parseZip(zip);
    expect(decoder.decode(await readRecord(records[0]!))).toBe(text);
    expect(decoder.decode(await readRecord(records[1]!))).toBe("after the descriptor");
  });

  it("exposes the stored payload, timestamp and deflate hint of each entry", () => {
    const data = utf8("payload ".repeat(30));
    const zip = handmadeZip([{ name: "x.txt", data, level: 9, flags: 0x0002, dosTime: 0x4321, dosDate: 0x5999 }]);
    const [record] = parseZip(zip).records;
    expect([...record!.compressed]).toEqual([...rawDeflate(data, 9)]);
    expect(record).toMatchObject({ dosTime: 0x4321, dosDate: 0x5999, flags: 0x0002 });
  });

  it("decodes UTF-8 names, flagged or not, and falls back to code page 437", () => {
    const zip = handmadeZip([
      { name: "docs/résumé – 履歴書.txt", data: "a" },
      { name: utf8("unflagged/naïve.txt"), data: "b", flags: 0 },
      { name: Uint8Array.from([0x82, 0x2e, 0x74, 0x78, 0x74]), data: "c", flags: 0 },
    ]);
    expect(parseZip(zip).records.map((record) => record.name)).toEqual([
      "docs/résumé – 履歴書.txt",
      "unflagged/naïve.txt",
      "é.txt",
    ]);
  });

  it("refuses a name flagged UTF-8 that is not valid UTF-8", () => {
    const zip = handmadeZip([{ name: Uint8Array.from([0x61, 0xff, 0xfe]), data: "a", flags: 0x0800 }]);
    expect(failure(() => parseZip(zip))).toEqual({ code: "corrupt_package", reason: "corrupt_zip" });
  });

  it("skips extra fields that differ between the local header and the central directory", async () => {
    const zip = handmadeZip([
      { name: "x.txt", data: "with extras", localExtra: Uint8Array.from([0x55, 0x54, 1, 0, 3]), centralExtra: Uint8Array.from([0x0a, 0, 2, 0, 9, 9]), comment: utf8("entry comment") },
      { name: "y.txt", data: "next" },
    ]);
    const { records } = parseZip(zip);
    expect(decoder.decode(await readRecord(records[0]!))).toBe("with extras");
    expect(decoder.decode(await readRecord(records[1]!))).toBe("next");
  });

  it("finds the end record behind an archive comment, even one that contains the end signature", () => {
    const comment = concat([0x50, 0x4b, 0x05, 0x06], utf8("looks like an end record but is a comment"));
    const zip = handmadeZip([{ name: "x.txt", data: "commented" }], { comment });
    expect(parseZip(zip).records.map((record) => record.name)).toEqual(["x.txt"]);
  });

  it("reads an archive with no entries", () => {
    expect(parseZip(handmadeZip([])).records).toEqual([]);
  });
});

describe("parseZip refuses what it cannot read safely", () => {
  it.each([
    ["an empty file", new Uint8Array(0)],
    ["plain text", utf8("this is not an archive, it is a sentence that is long enough")],
    ["an archive cut before its end record", handmadeZip([{ name: "x.txt", data: "cut" }]).subarray(0, 40)],
  ])("%s is not a ZIP", (_label, bytes) => {
    expect(failure(() => parseZip(bytes))).toEqual({ code: "not_a_zip", reason: "not_zip" });
  });

  it.each([
    ["the traditional encryption flag", { flags: 0x0001 }],
    ["the strong encryption flag", { flags: 0x0041 }],
    ["masked local headers", { flags: 0x2000 }],
    ["the AES method marker", { method: 99, rawPayload: new Uint8Array(4) }],
  ])("an entry with %s is unsupported", (_label, overrides) => {
    const zip = handmadeZip([{ name: "secret.xml", data: "hidden", ...overrides }]);
    expect(failure(() => parseZip(zip))).toEqual({ code: "unsupported_format", reason: "encrypted" });
  });

  it.each([
    ["a non-zero disk number", { diskNumber: 1 }],
    ["a central directory on another disk", { directoryDisk: 2 }],
    ["fewer entries on this disk than in total", { entriesOnDisk: 0 }],
  ])("an end record with %s is a multi-disk archive", (_label, options) => {
    const zip = handmadeZip([{ name: "x.txt", data: "spanned" }], options);
    expect(failure(() => parseZip(zip))).toEqual({ code: "unsupported_format", reason: "multi_disk" });
  });

  it("an entry that starts on another disk is a multi-disk archive", () => {
    const zip = handmadeZip([{ name: "x.txt", data: "spanned", diskStart: 1 }]);
    expect(failure(() => parseZip(zip))).toEqual({ code: "unsupported_format", reason: "multi_disk" });
  });

  it.each([
    ["a ZIP64 locator before the end record", {}, { beforeEnd: concat([0x50, 0x4b, 0x06, 0x07], new Uint8Array(16)) }],
    ["an entry count of 0xFFFF", {}, { entryCount: 0xffff, entriesOnDisk: 0xffff }],
    ["a directory offset of 0xFFFFFFFF", {}, { directoryOffset: 0xffffffff }],
    ["a directory size of 0xFFFFFFFF", {}, { directorySize: 0xffffffff }],
    ["an uncompressed size of 0xFFFFFFFF", { uncompressedSize: 0xffffffff }, {}],
    ["a compressed size of 0xFFFFFFFF", { compressedSize: 0xffffffff }, {}],
    ["a local header offset of 0xFFFFFFFF", { localOffset: 0xffffffff }, {}],
  ])("%s is a ZIP64 archive", (_label, entry, options) => {
    const zip = handmadeZip([{ name: "x.txt", data: "large format", ...entry }], options);
    expect(failure(() => parseZip(zip))).toEqual({ code: "unsupported_format", reason: "zip64" });
  });

  it.each([
    ["deflate64", 9],
    ["bzip2", 12],
    ["zstandard", 93],
  ])("compression method %s is unsupported", (_label, method) => {
    const zip = handmadeZip([{ name: "x.txt", data: "other codec", method, rawPayload: new Uint8Array(8) }]);
    expect(failure(() => parseZip(zip))).toEqual({ code: "unsupported_format", reason: "unsupported_compression" });
  });

  it.each([
    ["a central directory past the end record", {}, { directoryOffset: 0x7fffffff }],
    ["a local header offset outside the archive", { localOffset: 0x00ffffff }, {}],
    ["a local header that names another entry", { localName: "y.txt" }, {}],
    ["a local header with another method", { localMethod: 0 }, {}],
    ["a payload that runs into the central directory", { compressedSize: 5000 }, {}],
    ["a stored entry with unequal sizes", { method: 0, uncompressedSize: 3 }, {}],
    ["more entries declared than present", {}, { entryCount: 3, entriesOnDisk: 3 }],
  ])("%s is corrupt", (_label, entry, options) => {
    const zip = handmadeZip([{ name: "x.txt", data: "damaged archive", ...entry }], options);
    expect(failure(() => parseZip(zip))).toEqual({ code: "corrupt_package", reason: "corrupt_zip" });
  });

  it("refuses an entry whose stored bytes lie inside another entry", () => {
    // The local record of b.txt, embedded as the content of a stored entry.
    const inner = handmadeZip([{ name: "b.txt", data: "nested payload ".repeat(20) }]);
    const innerRecord = parseZip(inner).records[0]!;
    const innerLocal = inner.subarray(0, 30 + "b.txt".length + innerRecord.compressedSize);
    const zip = handmadeZip([
      { name: "a.bin", data: innerLocal, method: 0 },
      { name: "b.txt", data: "nested payload ".repeat(20), localOffset: 30 + "a.bin".length },
    ]);
    let message = "";
    expect(
      failure(() => {
        try {
          parseZip(zip);
        } catch (error) {
          message = error instanceof Error ? error.message : "";
          throw error;
        }
      }),
    ).toEqual({ code: "corrupt_package", reason: "corrupt_zip" });
    expect(message).toMatch(/overlap/);
  });

  it.each([
    "../evil.txt",
    "word/../../evil.txt",
    "/etc/passwd",
    "C:/Windows/system.ini",
    "word\\document.xml",
    "word/./document.xml",
    "word//document.xml",
    "..",
    "bad\u0000name.xml",
    "line\nbreak.xml",
  ])("refuses the unsafe entry name %j", (name) => {
    const zip = handmadeZip([{ name, data: "payload" }]);
    expect(failure(() => parseZip(zip))).toEqual({ code: "corrupt_package", reason: "unsafe_entry_name" });
  });

  it("refuses an empty entry name", () => {
    const zip = handmadeZip([{ name: "", data: "payload" }]);
    expect(failure(() => parseZip(zip))).toEqual({ code: "corrupt_package", reason: "unsafe_entry_name" });
  });

  it.each([
    ["the same name twice", "word/document.xml", "word/document.xml"],
    ["names that differ only in ASCII case", "word/document.xml", "Word/Document.XML"],
  ])("refuses %s", (_label, first, second) => {
    const zip = handmadeZip([
      { name: first, data: "one" },
      { name: second, data: "two" },
    ]);
    expect(failure(() => parseZip(zip))).toEqual({ code: "corrupt_package", reason: "duplicate_entry" });
  });
});

describe("readRecord verifies what it inflates", () => {
  it("refuses a CRC mismatch in a deflated and in a stored entry", async () => {
    const zip = handmadeZip([
      { name: "deflated.txt", data: "checksum me ".repeat(20), crc: 0x12345678 },
      { name: "stored.txt", data: "checksum me too", method: 0, crc: 0x12345678 },
    ]);
    const { records } = parseZip(zip);
    for (const record of records) {
      expect(await asyncFailure(() => readRecord(record))).toEqual({ code: "corrupt_package", reason: "crc_mismatch" });
    }
  });

  it("refuses a deflate stream that is damaged or cut short", async () => {
    const good = rawDeflate(utf8("a body that compresses ".repeat(40)));
    const zip = handmadeZip([
      { name: "garbage.txt", data: "x".repeat(100), rawPayload: Uint8Array.from([0xff, 0xff, 0xff, 0xff, 0x07, 0x09]) },
      { name: "short.txt", data: "a body that compresses ".repeat(40), rawPayload: good.subarray(0, good.length - 4) },
    ]);
    for (const record of parseZip(zip).records) {
      expect(await asyncFailure(() => readRecord(record))).toEqual({ code: "corrupt_package", reason: "corrupt_zip" });
    }
  });

  it("refuses an entry that inflates to fewer bytes than it declares", async () => {
    const zip = handmadeZip([{ name: "x.txt", data: "short body", uncompressedSize: 500, crc: checksum(utf8("short body")) }]);
    const [record] = parseZip(zip).records;
    expect(await asyncFailure(() => readRecord(record!))).toEqual({ code: "corrupt_package", reason: "size_mismatch" });
  });
});
