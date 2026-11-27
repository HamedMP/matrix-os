import { unzipSync } from "fflate";
import { describe, expect, it } from "vitest";

import { isOfficeError } from "../../../packages/office/src/errors.js";
import {
  CONTENT_TYPE_RELATIONSHIPS,
  RELATIONSHIP_TYPE_OFFICE_DOCUMENT,
  createPackage,
  findMainDocumentPart,
  openPackage,
} from "../../../packages/office/src/opc/index.js";
import { CONTENT_TYPES_XML, DOCUMENT_RELS_XML, IMAGE_BYTES, ROOT_RELS_XML, handmadeDocx, handmadeZip, utf8 } from "./handmade-zip.js";

const decoder = new TextDecoder();
const DOCUMENT_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml";
const STYLES_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml";
const FOOTNOTES_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml";
const IMAGE_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image";

function codeOf(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    if (isOfficeError(error)) return error.code;
    throw error;
  }
  throw new Error("expected an OfficeError");
}

describe("content types", () => {
  it("round-trips defaults and overrides through a changed [Content_Types].xml", async () => {
    const pkg = await openPackage(handmadeDocx());
    expect(pkg.getContentTypes()).toEqual({
      defaults: [
        { extension: "rels", contentType: CONTENT_TYPE_RELATIONSHIPS },
        { extension: "xml", contentType: "application/xml" },
        { extension: "png", contentType: "image/png" },
      ],
      overrides: [
        { partName: "/word/document.xml", contentType: DOCUMENT_TYPE },
        { partName: "/word/styles.xml", contentType: STYLES_TYPE },
      ],
    });

    pkg.setDefaultContentType(".JPEG", "image/jpeg");
    pkg.setPart("/word/footnotes.xml", "<w:footnotes/>", FOOTNOTES_TYPE);
    pkg.setPart("/word/media/chart & <1>.emf", Uint8Array.from([1, 2, 3]), 'image/x-emf; note="quoted"');
    const expected = pkg.getContentTypes();
    expect(expected.defaults.at(-1)).toEqual({ extension: "jpeg", contentType: "image/jpeg" });
    expect(expected.overrides.slice(2)).toEqual([
      { partName: "/word/footnotes.xml", contentType: FOOTNOTES_TYPE },
      { partName: "/word/media/chart & <1>.emf", contentType: 'image/x-emf; note="quoted"' },
    ]);

    const saved = await pkg.save();
    const reopened = await openPackage(saved);
    expect(reopened.getContentTypes()).toEqual(expected);
    expect(reopened.getContentType("/word/media/chart & <1>.emf")).toBe('image/x-emf; note="quoted"');
    // The written stream is well-formed XML with the standard namespace.
    const xml = decoder.decode(unzipSync(saved)["[Content_Types].xml"]);
    expect(xml).toContain('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">');
    expect(xml).toContain('PartName="/word/media/chart &amp; &lt;1&gt;.emf"');
    expect(xml).toContain('ContentType="image/x-emf; note=&quot;quoted&quot;"');
  });

  it("resolves an override before a default, without regard to case", async () => {
    const pkg = await openPackage(handmadeDocx());
    expect(pkg.getContentType("/word/document.xml")).toBe(DOCUMENT_TYPE);
    expect(pkg.getContentType("WORD/DOCUMENT.XML")).toBe(DOCUMENT_TYPE);
    expect(pkg.getContentType("/docProps/core.xml")).toBe("application/xml");
    expect(pkg.getContentType("/word/media/photo.PNG")).toBe("image/png");
    expect(pkg.getContentType("/customXml/item1.bin")).toBeNull();
    expect(pkg.getContentType("/noextension")).toBeNull();
  });

  it("uses the default instead of an override when the default already gives the type", async () => {
    const pkg = await openPackage(handmadeDocx());
    pkg.setPart("/word/media/image2.png", Uint8Array.from([1]), "image/png");
    expect(pkg.getContentTypes().overrides).toHaveLength(2);
    // Changing the type of an existing part adds an override; changing it back removes it again.
    pkg.setPart("/word/media/image2.png", Uint8Array.from([1]), "image/apng");
    expect(pkg.getContentTypes().overrides.at(-1)).toEqual({ partName: "/word/media/image2.png", contentType: "image/apng" });
    pkg.setPart("/word/media/image2.png", Uint8Array.from([1]), "image/png");
    expect(pkg.getContentTypes().overrides).toHaveLength(2);
  });

  it("a replaced default changes what its extension resolves to", async () => {
    const pkg = await openPackage(handmadeDocx());
    pkg.setDefaultContentType("png", "image/x-png");
    expect(pkg.getContentType("/word/media/image1.png")).toBe("image/x-png");
    expect(codeOf(() => pkg.setDefaultContentType("", "image/png"))).toBe("invalid_argument");
    expect(codeOf(() => pkg.setDefaultContentType("png", " "))).toBe("invalid_argument");
  });
});

describe("setPart and removePart", () => {
  it("keeps the type of an existing part and requires one for a new part without a default", async () => {
    const pkg = await openPackage(handmadeDocx());
    pkg.setPart("word/document.xml", "<w:document/>");
    expect(pkg.getContentType("/word/document.xml")).toBe(DOCUMENT_TYPE);
    expect(await pkg.getPartText("/word/document.xml")).toBe("<w:document/>");

    expect(codeOf(() => pkg.setPart("/word/vbaProject.dat", Uint8Array.from([1])))).toBe("invalid_operation");
    expect(pkg.hasPart("/word/vbaProject.dat")).toBe(false);
    pkg.setPart("/word/extra.xml", "<extra/>");
    expect(pkg.getContentType("/word/extra.xml")).toBe("application/xml");
  });

  it("reports the new size and marks only the set part as modified", async () => {
    const pkg = await openPackage(handmadeDocx());
    pkg.setPart("/WORD/STYLES.XML", "größer");
    const styles = pkg.listParts().find((part) => part.name === "/word/styles.xml");
    // The stored casing is kept and the string is encoded as UTF-8.
    expect(styles).toMatchObject({ size: utf8("größer").length, modified: true, contentType: STYLES_TYPE });
    expect(pkg.listParts().filter((part) => part.modified)).toHaveLength(1);
    expect([...(await pkg.getPartBytes("/word/styles.xml"))]).toEqual([...utf8("größer")]);
  });

  it("refuses to set or remove the content-type stream and relationships parts directly", async () => {
    const pkg = await openPackage(handmadeDocx());
    expect(codeOf(() => pkg.setPart("/[Content_Types].xml", "<Types/>"))).toBe("invalid_operation");
    expect(codeOf(() => pkg.setPart("/_rels/.rels", "<Relationships/>"))).toBe("invalid_operation");
    expect(codeOf(() => pkg.setPart("/word/_rels/document.xml.rels", "<Relationships/>"))).toBe("invalid_operation");
    expect(codeOf(() => pkg.removePart("/[Content_Types].xml"))).toBe("invalid_operation");
    expect(codeOf(() => pkg.removePart("/word/_rels/document.xml.rels"))).toBe("invalid_operation");
  });

  it.each(["/word/%5Frels/document.xml.rels", "/word/_rels/document.xml%2Erels", "/%5Frels/.rels", "/%5Frels/%2Erels", "/[Content%5FTypes].xml"])(
    "refuses a protected part spelled with percent escapes: %j",
    async (name) => {
      const pkg = await openPackage(handmadeDocx());
      const before = pkg.getRelationships("/word/document.xml");
      expect(codeOf(() => pkg.setPart(name, "<Relationships/>", "application/xml"))).toBe("invalid_operation");
      expect(codeOf(() => pkg.removePart(name))).toBe("invalid_operation");
      expect(pkg.getRelationships("/word/document.xml")).toEqual(before);
      expect(pkg.hasPart("/word/_rels/document.xml.rels")).toBe(true);
      expect(pkg.hasPart("/_rels/.rels")).toBe(true);
      expect(pkg.listParts({ includeRelationships: true }).filter((part) => part.modified)).toEqual([]);
    },
  );

  it("refuses a protected part as a relationship source when it is spelled with percent escapes", async () => {
    const pkg = await openPackage(handmadeDocx());
    expect(codeOf(() => pkg.getRelationships("/word/%5Frels/document.xml.rels"))).toBe("invalid_operation");
    expect(codeOf(() => pkg.addRelationship("/word/%5Frels/document.xml.rels", { type: "t", target: "x.xml" }))).toBe(
      "invalid_operation",
    );
  });

  it("treats an archive entry spelled with percent escapes as the relationships part it names", async () => {
    const pkg = await openPackage(
      handmadeZip([
        { name: "[Content_Types].xml", data: CONTENT_TYPES_XML },
        { name: "_rels/.rels", data: ROOT_RELS_XML },
        { name: "word/document.xml", data: "<w:document/>" },
        { name: "word/%5Frels/document.xml.rels", data: DOCUMENT_RELS_XML },
      ]),
    );
    expect(pkg.getRelationships("/word/document.xml").map((rel) => rel.id)).toEqual(["rId1", "rId7", "rId3"]);
    expect(pkg.listParts().map((part) => part.name)).toEqual(["/word/document.xml"]);
    expect(codeOf(() => pkg.setPart("/word/_rels/document.xml.rels", "<Relationships/>"))).toBe("invalid_operation");
  });

  it.each([
    ["a drive prefix", "C:/x.xml"],
    ["a bare drive prefix", "/c:x.xml"],
    ["a control character", "/word/a\u0001b.xml"],
    ["a delete character", "/word/a\u007fb.xml"],
    ["a line break", "/word/a\nb.xml"],
    ["an unpaired surrogate", "/word/a\ud800b.xml"],
    ["a name too long for a ZIP entry", `/${"a".repeat(70_000)}.xml`],
  ])("refuses a new part name with %s, which the reader would reject", async (_label, name) => {
    const pkg = await openPackage(handmadeDocx());
    expect(codeOf(() => pkg.setPart(name, "<x/>", "application/xml"))).toBe("invalid_argument");
    expect(pkg.listParts().filter((part) => part.modified)).toEqual([]);
    expect(pkg.getContentTypes().overrides).toHaveLength(2);
  });

  it("every name setPart accepts reopens from the saved archive", async () => {
    const pkg = await openPackage(handmadeDocx());
    const names = ["/word/ab:c.xml", "/word/ünïcödé.xml", "/word/%20space.xml", "/word/emoji-\u{1f600}.xml"];
    for (const name of names) pkg.setPart(name, "<x/>", "application/xml");
    const reopened = await openPackage(await pkg.save());
    for (const name of names) expect(await reopened.getPartText(name)).toBe("<x/>");
  });

  it.each(["", "/", "/word//document.xml", "/word/../document.xml", "/word/./document.xml", "word\\document.xml", "/word/"])(
    "refuses the part name %j",
    async (name) => {
      const pkg = await openPackage(handmadeDocx());
      expect(codeOf(() => pkg.setPart(name, "x", "text/plain"))).toBe("invalid_argument");
      expect(codeOf(() => pkg.hasPart(name))).toBe("invalid_argument");
      await expect(pkg.getPartBytes(name)).rejects.toMatchObject({ code: "invalid_argument" });
    },
  );

  it("removes a part with its override and its own relationships part", async () => {
    const pkg = await openPackage(handmadeDocx());
    expect(pkg.removePart("/word/document.xml")).toBe(true);
    expect(pkg.removePart("/word/document.xml")).toBe(false);
    expect(pkg.hasPart("/word/document.xml")).toBe(false);
    expect(pkg.hasPart("/word/_rels/document.xml.rels")).toBe(false);
    expect(pkg.getRelationships("/word/document.xml")).toEqual([]);
    expect(pkg.getContentTypes().overrides.map((entry) => entry.partName)).toEqual(["/word/styles.xml"]);
    // The relationship that points at it from the package is left for the caller.
    expect(pkg.getRelationships("/")).toHaveLength(1);

    const names = Object.keys(unzipSync(await pkg.save()));
    expect(names).not.toContain("word/document.xml");
    expect(names).not.toContain("word/_rels/document.xml.rels");
    expect(names).toContain("word/styles.xml");
  });

  it("removes the override of the part's relationships part too, so the saved package stays consistent", async () => {
    const typesWithRelsOverride = CONTENT_TYPES_XML.replace(
      "</Types>",
      `<Override PartName="/word/_rels/document.xml.rels" ContentType="${CONTENT_TYPE_RELATIONSHIPS}"/></Types>`,
    );
    const pkg = await openPackage(
      handmadeZip([
        { name: "[Content_Types].xml", data: typesWithRelsOverride },
        { name: "_rels/.rels", data: ROOT_RELS_XML },
        { name: "word/document.xml", data: "<w:document/>" },
        { name: "word/_rels/document.xml.rels", data: DOCUMENT_RELS_XML },
        { name: "word/styles.xml", data: "<w:styles/>" },
      ]),
    );
    expect(pkg.getContentTypes().overrides.map((entry) => entry.partName)).toContain("/word/_rels/document.xml.rels");
    expect(pkg.removePart("/word/document.xml")).toBe(true);
    expect(pkg.getContentTypes().overrides.map((entry) => entry.partName)).toEqual(["/word/styles.xml"]);

    const saved = await pkg.save();
    const xml = decoder.decode(unzipSync(saved)["[Content_Types].xml"]);
    expect(xml).not.toContain("document.xml");
    expect((await openPackage(saved)).getContentTypes().overrides.map((entry) => entry.partName)).toEqual(["/word/styles.xml"]);
  });

  it("a part removed and set again is a new part at the end", async () => {
    const pkg = await openPackage(handmadeDocx());
    pkg.removePart("/word/styles.xml");
    pkg.setPart("/word/styles.xml", "<w:styles/>", STYLES_TYPE);
    expect(pkg.listParts().at(-1)).toMatchObject({ name: "/word/styles.xml", modified: true, contentType: STYLES_TYPE });
    const names = Object.keys(unzipSync(await pkg.save()));
    expect(names.at(-1)).toBe("word/styles.xml");
  });
});

describe("relationships", () => {
  it("reads relationships in document order with decoded targets", async () => {
    const pkg = await openPackage(handmadeDocx());
    expect(pkg.getRelationships("/")).toEqual([
      { id: "rId1", type: RELATIONSHIP_TYPE_OFFICE_DOCUMENT, target: "word/document.xml", targetMode: "Internal" },
    ]);
    expect(pkg.getRelationships("word/document.xml").map((rel) => [rel.id, rel.target, rel.targetMode])).toEqual([
      ["rId1", "styles.xml", "Internal"],
      ["rId7", "media/image1.png", "Internal"],
      ["rId3", "https://example.com/a?b=1&c=2", "External"],
    ]);
    expect(pkg.getRelationship("/word/document.xml", "rId7")?.type).toBe(IMAGE_REL);
    expect(pkg.getRelationship("/word/document.xml", "rId99")).toBeNull();
    expect(pkg.getRelationshipsByType("/word/document.xml", IMAGE_REL).map((rel) => rel.id)).toEqual(["rId7"]);
    expect(pkg.getRelationships("/word/styles.xml")).toEqual([]);
    expect(pkg.getRelationships("/word/absent.xml")).toEqual([]);
  });

  it("allocates the next free id above the highest in use and refuses a duplicate", async () => {
    const pkg = await openPackage(handmadeDocx());
    const first = pkg.addRelationship("/word/document.xml", { type: IMAGE_REL, target: "media/image2.png" });
    expect(first).toEqual({ id: "rId8", type: IMAGE_REL, target: "media/image2.png", targetMode: "Internal" });
    const named = pkg.addRelationship("/word/document.xml", { type: IMAGE_REL, target: "media/image3.png", id: "rId20" });
    expect(named.id).toBe("rId20");
    expect(pkg.addRelationship("/word/document.xml", { type: "urn:t", target: "https://example.com/", targetMode: "External" }).id).toBe("rId21");
    expect(codeOf(() => pkg.addRelationship("/word/document.xml", { type: IMAGE_REL, target: "x.png", id: "rId7" }))).toBe("invalid_operation");
    expect(codeOf(() => pkg.addRelationship("/word/document.xml", { type: "", target: "x.png" }))).toBe("invalid_argument");
    expect(codeOf(() => pkg.addRelationship("/word/document.xml", { type: IMAGE_REL, target: "" }))).toBe("invalid_argument");
    expect(codeOf(() => pkg.addRelationship("/word/document.xml", { type: IMAGE_REL, target: "x.png", id: "1 bad" }))).toBe("invalid_argument");
    expect(pkg.getRelationships("/word/document.xml")).toHaveLength(6);
  });

  it("returned relationships are copies: changing one does not change the package", async () => {
    const pkg = await openPackage(handmadeDocx());
    const [first] = pkg.getRelationships("/");
    first!.target = "elsewhere.xml";
    expect(pkg.getRelationships("/")[0]?.target).toBe("word/document.xml");
  });

  it("round-trips added and removed relationships through a saved package", async () => {
    const pkg = await openPackage(handmadeDocx());
    pkg.addRelationship("/word/document.xml", { type: IMAGE_REL, target: "media/a&b <c>.png" });
    pkg.addRelationship("/word/document.xml", { type: "urn:link", target: 'https://example.com/?q="x"&r=1', targetMode: "External" });
    expect(pkg.removeRelationship("/word/document.xml", "rId1")).toBe(true);
    expect(pkg.removeRelationship("/word/document.xml", "rId1")).toBe(false);
    expect(pkg.removeRelationship("/word/absent.xml", "rId1")).toBe(false);
    const expected = pkg.getRelationships("/word/document.xml");
    expect(expected.map((rel) => rel.id)).toEqual(["rId7", "rId3", "rId8", "rId9"]);
    expect(pkg.listParts({ includeRelationships: true }).filter((part) => part.modified).map((part) => part.name)).toEqual([
      "/word/_rels/document.xml.rels",
    ]);

    const saved = await pkg.save();
    const reopened = await openPackage(saved);
    expect(reopened.getRelationships("/word/document.xml")).toEqual(expected);
    expect(reopened.getRelationships("/")).toEqual(pkg.getRelationships("/"));
    const xml = decoder.decode(unzipSync(saved)["word/_rels/document.xml.rels"]);
    expect(xml).toContain('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">');
    expect(xml).toContain('Target="media/a&amp;b &lt;c&gt;.png"/>');
    expect(xml).toContain('TargetMode="External"/>');
    // The current bytes of a changed relationships part are readable before saving too.
    expect(await pkg.getPartText("/word/_rels/document.xml.rels")).toBe(xml);
  });

  it("creates a relationships part for a source that had none and drops it again when emptied", async () => {
    const pkg = await openPackage(handmadeDocx());
    expect(pkg.hasPart("/word/_rels/styles.xml.rels")).toBe(false);
    const added = pkg.addRelationship("/word/styles.xml", { type: "urn:theme", target: "theme/theme1.xml" });
    expect(added.id).toBe("rId1");
    expect(pkg.listParts({ includeRelationships: true }).at(-1)).toMatchObject({
      name: "/word/_rels/styles.xml.rels",
      isRelationships: true,
      modified: true,
      contentType: CONTENT_TYPE_RELATIONSHIPS,
    });
    expect(Object.keys(unzipSync(await pkg.save())).at(-1)).toBe("word/_rels/styles.xml.rels");

    expect(pkg.removeRelationship("/word/styles.xml", "rId1")).toBe(true);
    expect(pkg.hasPart("/word/_rels/styles.xml.rels")).toBe(false);
    expect(Object.keys(unzipSync(await pkg.save()))).not.toContain("word/_rels/styles.xml.rels");
  });

  it("refuses relationships for a source that is missing or cannot own any", async () => {
    const pkg = await openPackage(handmadeDocx());
    expect(codeOf(() => pkg.addRelationship("/word/absent.xml", { type: "urn:t", target: "x.xml" }))).toBe("not_found");
    expect(codeOf(() => pkg.addRelationship("/_rels/.rels", { type: "urn:t", target: "x.xml" }))).toBe("invalid_operation");
    expect(codeOf(() => pkg.addRelationship("/[Content_Types].xml", { type: "urn:t", target: "x.xml" }))).toBe("invalid_operation");
  });

  it("resolves targets against their source", async () => {
    const pkg = await openPackage(handmadeDocx());
    expect(pkg.resolveTarget("/word/document.xml", "media/image1.png")).toBe("/word/media/image1.png");
    expect(pkg.resolveTarget("/word/document.xml", "../customXml/item1.xml")).toBe("/customXml/item1.xml");
    expect(pkg.resolveTarget("/word/document.xml", "/docProps/core.xml")).toBe("/docProps/core.xml");
    expect(pkg.resolveTarget("/word/document.xml", "./styles.xml#anchor")).toBe("/word/styles.xml");
    expect(pkg.resolveTarget("/", "word/document.xml")).toBe("/word/document.xml");
    expect(codeOf(() => pkg.resolveTarget("/word/document.xml", "../../outside.xml"))).toBe("invalid_argument");
    expect(codeOf(() => pkg.resolveTarget("/", "../outside.xml"))).toBe("invalid_argument");
    expect(codeOf(() => pkg.resolveTarget("/word/document.xml", "#fragment-only"))).toBe("invalid_argument");
  });
});

describe("createPackage", () => {
  it("starts with the rels and xml defaults and no parts", () => {
    const pkg = createPackage();
    expect(pkg.listParts({ includeRelationships: true })).toEqual([]);
    expect(pkg.getContentTypes()).toEqual({
      defaults: [
        { extension: "rels", contentType: CONTENT_TYPE_RELATIONSHIPS },
        { extension: "xml", contentType: "application/xml" },
      ],
      overrides: [],
    });
  });

  it("builds a package that reopens with the same parts, types and relationships", async () => {
    const pkg = createPackage();
    pkg.setPart("/word/document.xml", "<w:document/>", DOCUMENT_TYPE);
    pkg.setPart("/word/media/image1.png", Uint8Array.from([137, 80, 78, 71]), "image/png");
    pkg.addRelationship("/", { type: RELATIONSHIP_TYPE_OFFICE_DOCUMENT, target: "word/document.xml" });
    pkg.addRelationship("/word/document.xml", { type: IMAGE_REL, target: "media/image1.png" });
    const saved = await pkg.save();

    expect(Object.keys(unzipSync(saved))).toEqual([
      "[Content_Types].xml",
      "_rels/.rels",
      "word/document.xml",
      "word/media/image1.png",
      "word/_rels/document.xml.rels",
    ]);
    const reopened = await openPackage(saved);
    expect(findMainDocumentPart(reopened)).toBe("/word/document.xml");
    expect(reopened.listParts()).toEqual([
      { name: "/word/document.xml", contentType: DOCUMENT_TYPE, size: 13, isRelationships: false, modified: false },
      { name: "/word/media/image1.png", contentType: "image/png", size: 4, isRelationships: false, modified: false },
    ]);
    expect(reopened.getRelationships("/word/document.xml")).toEqual(pkg.getRelationships("/word/document.xml"));
    // Saving the reopened package without edits reproduces the archive exactly.
    expect([...(await reopened.save())]).toEqual([...saved]);
    // The package stays usable after a save.
    pkg.setPart("/word/styles.xml", "<w:styles/>");
    expect(Object.keys(unzipSync(await pkg.save()))).toContain("word/styles.xml");
  });
});

describe("openPackage refuses damaged packages", () => {
  const typed = (data: string) => ({ name: "[Content_Types].xml", data });

  it("an OLE compound file is an unsupported format", async () => {
    const ole = new Uint8Array(512);
    ole.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    await expect(openPackage(ole)).rejects.toMatchObject({ code: "unsupported_format" });
  });

  it("bytes without a ZIP structure are not a ZIP", async () => {
    await expect(openPackage(utf8("%PDF-1.7 not an office file at all, just text"))).rejects.toMatchObject({ code: "not_a_zip" });
  });

  it.each([
    ["no [Content_Types].xml", [{ name: "word/document.xml", data: "<w:document/>" }]],
    ["content types that are not XML", [typed("not xml at all")]],
    ["content types with another document element", [typed("<Other/>")]],
    ["a Default without ContentType", [typed('<Types><Default Extension="xml"/></Types>')]],
    ["an Override with a traversal part name", [typed('<Types><Override PartName="/../x.xml" ContentType="a/b"/></Types>')]],
    ["content types that declare a document type", [typed('<!DOCTYPE Types [<!ENTITY e "x">]><Types/>')]],
    ["content types that use an undeclared entity", [typed('<Types><Default Extension="xml" ContentType="&e;"/></Types>')]],
    ["content types with text before the document element", [typed("garbage<Types/>")]],
    ["content types with text after the document element", [typed("<Types/>garbage")]],
    ["content types with an undefined entity in text", [typed("<Types>&undefined;</Types>")]],
    ["content types with a bare ampersand in text", [typed("<Types>a & b</Types>")]],
    ["content types with an inherited property name as an entity", [typed('<Types><Default Extension="xml" ContentType="&constructor;"/></Types>')]],
    ["content types with an inherited property name as an entity in text", [typed("<Types>&toString;</Types>")]],
    ["content types with a forbidden character", [typed("<Types>\u0001</Types>")]],
    ["content types with a malformed element name", [typed('<Types><1Default Extension="xml" ContentType="a/b"/></Types>')]],
    ["relationships with text before the document element", [typed(CONTENT_TYPES_XML), { name: "_rels/.rels", data: "junk<Relationships/>" }]],
    ["relationships with an undefined entity in text", [typed(CONTENT_TYPES_XML), { name: "_rels/.rels", data: "<Relationships>&nope;</Relationships>" }]],
    ["relationships that are not well formed", [typed(CONTENT_TYPES_XML), { name: "_rels/.rels", data: "<Relationships><Relationship" }]],
    ["relationships with another document element", [typed(CONTENT_TYPES_XML), { name: "_rels/.rels", data: "<Types/>" }]],
    ["a relationship without Target", [typed(CONTENT_TYPES_XML), { name: "_rels/.rels", data: '<Relationships><Relationship Id="rId1" Type="t"/></Relationships>' }]],
    [
      "a repeated relationship id",
      [typed(CONTENT_TYPES_XML), { name: "word/document.xml", data: "<d/>" }, { name: "word/_rels/document.xml.rels", data: DOCUMENT_RELS_XML.replace("rId7", "rId1") }],
    ],
    ["a part stored under two escapings of one name", [typed(CONTENT_TYPES_XML), { name: "word/a%2Db.xml", data: "<a/>" }, { name: "word/a-b.xml", data: "<a/>" }]],
  ])("%s is a corrupt package", async (_label, entries) => {
    await expect(openPackage(handmadeZip(entries))).rejects.toMatchObject({ code: "corrupt_package" });
  });

  it("tolerates prefixed content-type elements, comments and unknown elements", async () => {
    const xml =
      '<?xml version="1.0"?><!-- generated --><ct:Types xmlns:ct="http://schemas.openxmlformats.org/package/2006/content-types">' +
      "<ct:Default Extension='XML' ContentType='application/xml' ></ct:Default><ct:Future><ct:Default Extension=\"zzz\" ContentType=\"x/y\"/></ct:Future>" +
      '<ct:Override ContentType="a/b" PartName="/doc.xml"/></ct:Types>';
    const pkg = await openPackage(handmadeZip([typed(xml), { name: "doc.xml", data: "<d/>" }, { name: "_rels/.rels", data: ROOT_RELS_XML }]));
    expect(pkg.getContentTypes()).toEqual({
      defaults: [{ extension: "xml", contentType: "application/xml" }],
      overrides: [{ partName: "/doc.xml", contentType: "a/b" }],
    });
  });
});

describe("save snapshots", () => {
  it("writes the package as it stood when save was called, even when a part changes while it runs", async () => {
    const pkg = await openPackage(handmadeDocx());
    const saving = pkg.save();
    // Runs while save is suspended: new bytes and a new content type for the same part.
    pkg.setPart("/word/media/image1.png", Uint8Array.from([9, 9, 9]), "image/x-changed");
    const reopened = await openPackage(await saving);
    expect(reopened.getContentType("/word/media/image1.png")).toBe("image/png");
    expect([...(await reopened.getPartBytes("/word/media/image1.png"))]).toEqual([...IMAGE_BYTES]);

    const later = await openPackage(await pkg.save());
    expect(later.getContentType("/word/media/image1.png")).toBe("image/x-changed");
    expect([...(await later.getPartBytes("/word/media/image1.png"))]).toEqual([9, 9, 9]);
  });

  it("keeps relationships and content types of overlapping saves in step with their parts", async () => {
    const pkg = await openPackage(handmadeDocx());
    pkg.setPart("/word/footnotes.xml", "<w:footnotes/>", FOOTNOTES_TYPE);
    const first = pkg.save();
    pkg.removePart("/word/footnotes.xml");
    pkg.addRelationship("/word/document.xml", { type: IMAGE_REL, target: "https://example.com/x.png", targetMode: "External" });
    const second = pkg.save();
    const [a, b] = await Promise.all([first, second]);
    const one = await openPackage(a);
    expect(one.hasPart("/word/footnotes.xml")).toBe(true);
    expect(one.getContentType("/word/footnotes.xml")).toBe(FOOTNOTES_TYPE);
    expect(one.getRelationshipsByType("/word/document.xml", IMAGE_REL)).toHaveLength(1);
    const two = await openPackage(b);
    expect(two.hasPart("/word/footnotes.xml")).toBe(false);
    expect(two.getContentTypes().overrides.map((entry) => entry.partName)).not.toContain("/word/footnotes.xml");
    expect(two.getRelationshipsByType("/word/document.xml", IMAGE_REL)).toHaveLength(2);
  });
});

describe("edits that a saved package could not reopen", () => {
  it("refuses forbidden characters at the mutation, so save never writes them", async () => {
    const pkg = await openPackage(handmadeDocx());
    const external = { type: IMAGE_REL, target: "https://example.com/\u0001", targetMode: "External" } as const;
    await expect(async () => pkg.addRelationship("/word/document.xml", external)).rejects.toMatchObject({ code: "invalid_argument" });
    await expect(async () => pkg.setDefaultContentType("bin", "application/￾")).rejects.toMatchObject({ code: "invalid_argument" });
    await expect(async () => pkg.setPart("/word/a.bin", "x", "application/\uD800")).rejects.toMatchObject({ code: "invalid_argument" });
    await expect(async () => pkg.setPart("/word/a￿.xml", "<a/>")).rejects.toMatchObject({ code: "invalid_argument" });
    expect(pkg.hasPart("/word/a.bin")).toBe(false);
    const reopened = await openPackage(await pkg.save());
    expect(reopened.getRelationshipsByType("/word/document.xml", IMAGE_REL)).toHaveLength(1);
  });
});
