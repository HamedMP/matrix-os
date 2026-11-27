import { unzipSync } from "fflate";
import { describe, expect, it } from "vitest";

import {
  FIXED_DOS_DATE,
  FIXED_DOS_TIME,
  type ZipRecord,
  findMainDocumentPart,
  openPackage,
  parseZip,
} from "../../../packages/office/src/opc/index.js";
import {
  CONTENT_TYPES_XML,
  DOCUMENT_RELS_XML,
  DOCUMENT_XML,
  IMAGE_BYTES,
  ROOT_RELS_XML,
  STYLES_XML,
  handmadeDocx,
  handmadeZip,
  utf8,
} from "./handmade-zip.js";

const decoder = new TextDecoder();
const DOCUMENT_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml";

function byName(bytes: Uint8Array): Map<string, ZipRecord> {
  return new Map(parseZip(bytes).records.map((record) => [record.name, record]));
}

/** Everything that identifies the stored form of an entry. */
function stored(record: ZipRecord) {
  return {
    method: record.method,
    crc32: record.crc32,
    compressedSize: record.compressedSize,
    uncompressedSize: record.uncompressedSize,
    dosTime: record.dosTime,
    dosDate: record.dosDate,
    flags: record.flags,
    compressed: [...record.compressed],
  };
}

function expectSameStoredBytes(before: Map<string, ZipRecord>, after: Map<string, ZipRecord>, except: string[] = []) {
  for (const [name, record] of before) {
    if (except.includes(name)) continue;
    expect(after.has(name), `${name} is still present`).toBe(true);
    expect(stored(after.get(name)!), `${name} is stored unchanged`).toEqual(stored(record));
  }
}

describe("openPackage on a hand-built word-processing package", () => {
  it("lists parts in archive order with their content types", async () => {
    const pkg = await openPackage(handmadeDocx());
    expect(pkg.listParts()).toEqual([
      { name: "/word/document.xml", contentType: DOCUMENT_TYPE, size: DOCUMENT_XML.length, isRelationships: false, modified: false },
      { name: "/word/styles.xml", contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml", size: STYLES_XML.length, isRelationships: false, modified: false },
      { name: "/word/media/image1.png", contentType: "image/png", size: IMAGE_BYTES.length, isRelationships: false, modified: false },
      { name: "/customXml/item1.bin", contentType: null, size: 43, isRelationships: false, modified: false },
    ]);
    expect(pkg.listParts({ includeRelationships: true }).map((part) => [part.name, part.isRelationships])).toEqual([
      ["/_rels/.rels", true],
      ["/word/document.xml", false],
      ["/word/_rels/document.xml.rels", true],
      ["/word/styles.xml", false],
      ["/word/media/image1.png", false],
      ["/customXml/item1.bin", false],
    ]);
  });

  it("reads parts as bytes and text, by name with or without the slash and in any case", async () => {
    const pkg = await openPackage(handmadeDocx());
    expect(await pkg.getPartText("/word/document.xml")).toBe(DOCUMENT_XML);
    expect(await pkg.getPartText("word/styles.xml")).toBe(STYLES_XML);
    expect(await pkg.getPartText("/WORD/Document.XML")).toBe(DOCUMENT_XML);
    expect([...(await pkg.getPartBytes("/word/media/image1.png"))]).toEqual([...IMAGE_BYTES]);
    expect(await pkg.getPartText("/_rels/.rels")).toBe(ROOT_RELS_XML);
    expect(pkg.hasPart("word/document.xml")).toBe(true);
    expect(pkg.hasPart("/word/missing.xml")).toBe(false);
    // Neither the content-type stream nor a directory entry is a part.
    expect(pkg.hasPart("/[Content_Types].xml")).toBe(false);
    expect(pkg.hasPart("/word")).toBe(false);
    await expect(pkg.getPartBytes("/word/missing.xml")).rejects.toMatchObject({ code: "not_found" });
    await expect(pkg.getPartBytes("/[Content_Types].xml")).rejects.toMatchObject({ code: "not_found" });
  });

  it("decodes UTF-16 parts by their byte order mark and drops a UTF-8 mark", async () => {
    const text = '<?xml version="1.0" encoding="UTF-16"?><a>größe 寸法</a>';
    const utf16le = new Uint8Array(2 + text.length * 2);
    utf16le.set([0xff, 0xfe]);
    for (let i = 0; i < text.length; i++) {
      utf16le[2 + i * 2] = text.charCodeAt(i) & 0xff;
      utf16le[3 + i * 2] = text.charCodeAt(i) >> 8;
    }
    const utf16be = new Uint8Array(utf16le.length);
    for (let i = 0; i < utf16le.length; i += 2) {
      utf16be[i] = utf16le[i + 1]!;
      utf16be[i + 1] = utf16le[i]!;
    }
    const withMark = new Uint8Array([0xef, 0xbb, 0xbf, ...utf8("<a>marked</a>")]);
    const pkg = await openPackage(
      handmadeZip([
        { name: "[Content_Types].xml", data: CONTENT_TYPES_XML },
        { name: "le.xml", data: utf16le },
        { name: "be.xml", data: utf16be },
        { name: "mark.xml", data: withMark },
        { name: "bad.xml", data: Uint8Array.from([0x3c, 0xff, 0xfe, 0x3e]) },
      ]),
    );
    expect(await pkg.getPartText("/le.xml")).toBe(text);
    expect(await pkg.getPartText("/be.xml")).toBe(text);
    expect(await pkg.getPartText("/mark.xml")).toBe("<a>marked</a>");
    await expect(pkg.getPartText("/bad.xml")).rejects.toMatchObject({ code: "corrupt_package" });
  });

  it("finds the main document part through the package relationship type", async () => {
    const pkg = await openPackage(handmadeDocx());
    expect(findMainDocumentPart(pkg)).toBe("/word/document.xml");

    const strict = ROOT_RELS_XML.replace(
      "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument",
      "http://purl.oclc.org/ooxml/officeDocument/relationships/officeDocument",
    ).replace('Target="word/document.xml"', 'Target="/xl/workbook.xml"');
    const workbook = await openPackage(
      handmadeZip([
        { name: "[Content_Types].xml", data: CONTENT_TYPES_XML },
        { name: "_rels/.rels", data: strict },
        { name: "xl/workbook.xml", data: "<workbook/>" },
      ]),
    );
    expect(findMainDocumentPart(workbook)).toBe("/xl/workbook.xml");

    const none = await openPackage(handmadeZip([{ name: "[Content_Types].xml", data: CONTENT_TYPES_XML }]));
    expect(findMainDocumentPart(none)).toBeNull();
  });
});

describe("save without edits", () => {
  it("writes every entry back with its original compressed bytes, method, CRC and timestamp", async () => {
    const source = handmadeDocx();
    const before = byName(source);
    const pkg = await openPackage(source);
    // Reading parts must not make them count as edited.
    await pkg.getPartText("/word/document.xml");
    await pkg.getPartBytes("/word/media/image1.png");
    pkg.getRelationships("/word/document.xml");
    const saved = await pkg.save();

    const after = byName(saved);
    expect([...after.keys()]).toEqual([...before.keys()]);
    expectSameStoredBytes(before, after);
    // The document part was stored as uncompressed deflate blocks; recompressing it would have shrunk it.
    expect(after.get("word/document.xml")!.compressedSize).toBeGreaterThan(DOCUMENT_XML.length);
  });

  it("gives the same archive on every save and after a second open", async () => {
    const pkg = await openPackage(handmadeDocx());
    const first = await pkg.save();
    const second = await pkg.save();
    expect([...second]).toEqual([...first]);
    const reopened = await (await openPackage(first)).save();
    expect([...reopened]).toEqual([...first]);
  });

  it("puts the content types first and the package relationships second, then keeps the original order", async () => {
    const source = handmadeZip([
      { name: "word/document.xml", data: DOCUMENT_XML },
      { name: "docProps/app.xml", data: "<Properties/>" },
      { name: "_rels/.rels", data: ROOT_RELS_XML },
      { name: "word/styles.xml", data: STYLES_XML },
      { name: "[Content_Types].xml", data: CONTENT_TYPES_XML },
    ]);
    const before = byName(source);
    const saved = await (await openPackage(source)).save();
    const after = byName(saved);
    expect([...after.keys()]).toEqual([
      "[Content_Types].xml",
      "_rels/.rels",
      "word/document.xml",
      "docProps/app.xml",
      "word/styles.xml",
    ]);
    expectSameStoredBytes(before, after);
  });

  it("produces an archive an independent reader extracts to the same content", async () => {
    const saved = await (await openPackage(handmadeDocx())).save();
    const extracted = unzipSync(saved);
    expect(decoder.decode(extracted["[Content_Types].xml"])).toBe(CONTENT_TYPES_XML);
    expect(decoder.decode(extracted["_rels/.rels"])).toBe(ROOT_RELS_XML);
    expect(decoder.decode(extracted["word/document.xml"])).toBe(DOCUMENT_XML);
    expect(decoder.decode(extracted["word/_rels/document.xml.rels"])).toBe(DOCUMENT_RELS_XML);
    expect([...extracted["word/media/image1.png"]!]).toEqual([...IMAGE_BYTES]);
  });
});

describe("save after one edit", () => {
  it("changes only the entry of the part that was set", async () => {
    const source = handmadeDocx();
    const before = byName(source);
    const pkg = await openPackage(source);
    const edited = DOCUMENT_XML.replace("Hello, package.", "Hello, edited package.");
    pkg.setPart("/word/document.xml", edited);
    expect(pkg.listParts().filter((part) => part.modified).map((part) => part.name)).toEqual(["/word/document.xml"]);

    const saved = await pkg.save();
    const after = byName(saved);
    expect([...after.keys()]).toEqual([...before.keys()]);
    expectSameStoredBytes(before, after, ["word/document.xml"]);

    const changed = after.get("word/document.xml")!;
    expect(changed.crc32).not.toBe(before.get("word/document.xml")!.crc32);
    expect(changed.method).toBe(8);
    expect([changed.dosTime, changed.dosDate]).toEqual([FIXED_DOS_TIME, FIXED_DOS_DATE]);
    const reopened = await openPackage(saved);
    expect(await reopened.getPartText("/word/document.xml")).toBe(edited);
    expect(await reopened.getPartText("/word/styles.xml")).toBe(STYLES_XML);
  });

  it("changes only the relationships entry when a relationship is added", async () => {
    const source = handmadeDocx();
    const before = byName(source);
    const pkg = await openPackage(source);
    pkg.addRelationship("/word/document.xml", { type: "urn:test:footnotes", target: "footnotes.xml" });
    const after = byName(await pkg.save());
    expectSameStoredBytes(before, after, ["word/_rels/document.xml.rels"]);
    expect(after.get("word/_rels/document.xml.rels")!.crc32).not.toBe(before.get("word/_rels/document.xml.rels")!.crc32);
  });

  it("changes only the content-type entry when a default is added, and nothing when it already matches", async () => {
    const source = handmadeDocx();
    const before = byName(source);
    const same = await openPackage(source);
    same.setDefaultContentType("png", "image/png");
    expectSameStoredBytes(before, byName(await same.save()));

    const pkg = await openPackage(source);
    pkg.setDefaultContentType("jpeg", "image/jpeg");
    const after = byName(await pkg.save());
    expectSameStoredBytes(before, after, ["[Content_Types].xml"]);
    expect(after.get("[Content_Types].xml")!.crc32).not.toBe(before.get("[Content_Types].xml")!.crc32);
  });

  it("appends a new part after the original entries", async () => {
    const source = handmadeDocx();
    const before = byName(source);
    const pkg = await openPackage(source);
    pkg.setPart("/word/footnotes.xml", "<w:footnotes/>");
    const after = byName(await pkg.save());
    expect([...after.keys()]).toEqual([...before.keys(), "word/footnotes.xml"]);
    // The new part's extension already has a Default, so the content types are untouched too.
    expectSameStoredBytes(before, after);
  });
});
