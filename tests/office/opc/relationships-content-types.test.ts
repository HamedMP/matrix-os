import { describe, expect, it } from "vitest";

import { isOfficeError } from "../../../packages/office/src/errors.js";
import { ContentTypeTable, RelationshipSet } from "../../../packages/office/src/opc/index.js";
import { CONTENT_TYPES_XML, DOCUMENT_RELS_XML, utf8 } from "./handmade-zip.js";

function codeOf(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    if (isOfficeError(error)) return error.code;
    throw error;
  }
  throw new Error("expected an OfficeError");
}

describe("RelationshipSet", () => {
  it("serializes to a part that parses back to the same relationships", () => {
    const set = RelationshipSet.parse(utf8(DOCUMENT_RELS_XML));
    set.add({ type: "urn:odd", target: "a b/ü&<>\"'.xml" });
    set.add({ type: "urn:ext", target: "mailto:someone@example.com?subject=a%20b", targetMode: "External", id: "link_1" });
    const reparsed = RelationshipSet.parse(set.serialize());
    expect(reparsed.list()).toEqual(set.list());
    expect(reparsed.list().at(-2)).toEqual({ id: "rId8", type: "urn:odd", target: "a b/ü&<>\"'.xml", targetMode: "Internal" });
    // Serializing an unchanged parse is stable.
    expect([...RelationshipSet.parse(reparsed.serialize()).serialize()]).toEqual([...set.serialize()]);
  });

  it("decodes character references and both quote styles, and reads TargetMode in any case", () => {
    const xml =
      "<Relationships xmlns='http://schemas.openxmlformats.org/package/2006/relationships'>\n" +
      "  <Relationship Target='a&#x26;b&#38;c &lt;d&gt; &quot;e&quot; &apos;f&apos;.xml' Type=\"t\" Id = \"x1\" />\n" +
      '  <Relationship Id="x2" Type="t" Target="https://example.com" TargetMode="external"></Relationship>\n' +
      "</Relationships>";
    expect(RelationshipSet.parse(utf8(xml)).list()).toEqual([
      { id: "x1", type: "t", target: "a&b&c <d> \"e\" 'f'.xml", targetMode: "Internal" },
      { id: "x2", type: "t", target: "https://example.com", targetMode: "External" },
    ]);
  });

  it("never hands out an id twice, even after the highest one was removed", () => {
    const set = new RelationshipSet();
    expect(set.add({ type: "t", target: "a" }).id).toBe("rId1");
    expect(set.add({ type: "t", target: "b" }).id).toBe("rId2");
    expect(set.remove("rId2")).toBe(true);
    expect(set.add({ type: "t", target: "c" }).id).toBe("rId3");
    expect(set.add({ type: "t", target: "d", id: "custom" }).id).toBe("custom");
    expect(set.add({ type: "t", target: "e" }).id).toBe("rId4");
    expect(set.list().map((item) => item.id)).toEqual(["rId1", "rId3", "custom", "rId4"]);
    expect(set.size).toBe(4);
  });

  it("parses a part with very many relationships without slowing down per entry", () => {
    const count = 60_000;
    let xml = '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">';
    for (let index = 1; index <= count; index++) {
      xml += `<Relationship Id="rId${index}" Type="urn:hyperlink" Target="https://example.com/${index}" TargetMode="External"/>`;
    }
    const set = RelationshipSet.parse(utf8(`${xml}</Relationships>`));
    expect(set.size).toBe(count);
    expect(set.get(`rId${count}`)?.target).toBe(`https://example.com/${count}`);
    expect(set.nextId()).toBe(`rId${count + 1}`);
  });

  it.each([
    ["a document type declaration", '<!DOCTYPE Relationships [<!ENTITY x "y">]><Relationships/>'],
    ["an undeclared entity", '<Relationships><Relationship Id="a" Type="t" Target="&x;"/></Relationships>'],
    ["an unterminated entity", '<Relationships><Relationship Id="a" Type="t" Target="a & b"/></Relationships>'],
    ["a character reference outside Unicode", '<Relationships><Relationship Id="a" Type="t" Target="&#x110000;"/></Relationships>'],
    ["an unquoted attribute", "<Relationships><Relationship Id=a Type='t' Target='x'/></Relationships>"],
    ["a repeated attribute", '<Relationships><Relationship Id="a" Id="b" Type="t" Target="x"/></Relationships>'],
    ["a mismatched end tag", "<Relationships><Relationship Id='a' Type='t' Target='x'></Relationships></Relationship>"],
    ["an unclosed document element", "<Relationships>"],
    ["two document elements", "<Relationships/><Relationships/>"],
    ["an unterminated comment", "<Relationships><!-- </Relationships>"],
    ["no element at all", "just text"],
    ["bytes that are not UTF-8", Uint8Array.from([0x3c, 0x52, 0xff, 0xff, 0x3e])],
  ])("refuses %s", (_label, source) => {
    const bytes = typeof source === "string" ? utf8(source) : source;
    expect(codeOf(() => RelationshipSet.parse(bytes))).toBe("corrupt_package");
  });
});

describe("ContentTypeTable", () => {
  it("serializes to a stream that parses back to the same table", () => {
    const table = ContentTypeTable.parse(utf8(CONTENT_TYPES_XML));
    table.setDefault("JPG", "image/jpeg");
    table.assign("/word/a&b.xml", "application/x-test+xml");
    const reparsed = ContentTypeTable.parse(table.serialize());
    expect(reparsed.snapshot()).toEqual(table.snapshot());
    expect(reparsed.typeOf("/word/a&b.xml")).toBe("application/x-test+xml");
    expect(reparsed.typeOf("/word/photo.jpg")).toBe("image/jpeg");
  });

  it("reports whether a change happened, so an unchanged table is never rewritten", () => {
    const table = ContentTypeTable.parse(utf8(CONTENT_TYPES_XML));
    expect(table.setDefault("png", "image/png")).toBe(false);
    expect(table.setDefault("png", "image/x-png")).toBe(true);
    expect(table.assign("/word/styles.xml", "application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml")).toBe(false);
    expect(table.assign("/word/other.xml", "application/xml")).toBe(false);
    expect(table.assign("/word/other.xml", "application/x-other+xml")).toBe(true);
    expect(table.removeOverride("/WORD/OTHER.XML")).toBe(true);
    expect(table.removeOverride("/word/other.xml")).toBe(false);
  });

  it("keeps the first of two entries for the same extension or part", () => {
    const xml =
      '<Types><Default Extension="xml" ContentType="first/xml"/><Default Extension="XML" ContentType="second/xml"/>' +
      '<Override PartName="/a.xml" ContentType="first/a"/><Override PartName="/A.xml" ContentType="second/a"/></Types>';
    const table = ContentTypeTable.parse(utf8(xml));
    expect(table.snapshot()).toEqual({
      defaults: [{ extension: "xml", contentType: "first/xml" }],
      overrides: [{ partName: "/a.xml", contentType: "first/a" }],
    });
  });

  it("the snapshot is detached from the table", () => {
    const table = ContentTypeTable.minimal();
    table.snapshot().defaults[0]!.contentType = "changed";
    expect(table.defaultFor("rels")).toBe("application/vnd.openxmlformats-package.relationships+xml");
  });
});

describe("text that XML cannot carry", () => {
  const FORBIDDEN = [
    ["a C0 control", "a\u0001b"],
    ["a form feed", "a\u000Cb"],
    ["U+FFFE", "a￾b"],
    ["U+FFFF", "a￿b"],
    ["a lone high surrogate", "a\uD800b"],
    ["a lone low surrogate", "a\uDC00b"],
  ] as const;

  it.each(FORBIDDEN)("a relationship type or target with %s is refused", (_label, text) => {
    const set = RelationshipSet.parse(utf8(DOCUMENT_RELS_XML));
    const before = set.list();
    expect(codeOf(() => set.add({ type: `urn:${text}`, target: "x.xml" }))).toBe("invalid_argument");
    expect(codeOf(() => set.add({ type: "urn:t", target: `https://example.com/${text}`, targetMode: "External" }))).toBe(
      "invalid_argument",
    );
    expect(set.list()).toEqual(before);
  });

  it.each(FORBIDDEN)("a content type or extension with %s is refused", (_label, text) => {
    const table = ContentTypeTable.parse(utf8(CONTENT_TYPES_XML));
    const before = table.snapshot();
    expect(codeOf(() => table.setDefault("bin", `application/${text}`))).toBe("invalid_argument");
    expect(codeOf(() => table.setDefault(`b${text}`, "application/x-b"))).toBe("invalid_argument");
    expect(codeOf(() => table.assign("/word/a.bin", `application/${text}`))).toBe("invalid_argument");
    expect(table.snapshot()).toEqual(before);
  });

  it("keeps tab, line breaks and characters outside the basic plane, which round-trip", () => {
    const set = RelationshipSet.parse(utf8(DOCUMENT_RELS_XML));
    set.add({ type: "urn:t\tx", target: "media/\u{1F600}\r\n.png" });
    expect(RelationshipSet.parse(set.serialize()).list()).toEqual(set.list());
    const table = ContentTypeTable.minimal();
    table.setDefault("emoji", "application/x-\u{1F600}");
    expect(ContentTypeTable.parse(table.serialize()).snapshot()).toEqual(table.snapshot());
  });
});
