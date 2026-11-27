import { describe, expect, it } from "vitest";

import { isOfficeError } from "../../../packages/office/src/errors.js";
import {
  entryNameToPartName,
  isRelationshipsPartName,
  normalizePartName,
  partDirectory,
  partExtension,
  partNameKey,
  partNameToEntryName,
  partNamesEqual,
  relationshipsPartNameFor,
  relationshipsSourceOf,
  relativeTargetFor,
  resolveRelationshipTarget,
} from "../../../packages/office/src/opc/index.js";

function refused(action: () => unknown): boolean {
  try {
    action();
  } catch (error) {
    if (isOfficeError(error, "invalid_argument")) return true;
    throw error;
  }
  return false;
}

describe("part name normalisation", () => {
  it("adds the leading slash and keeps the stored casing and escapes", () => {
    expect(normalizePartName("word/document.xml")).toBe("/word/document.xml");
    expect(normalizePartName("/Word/Document.XML")).toBe("/Word/Document.XML");
    expect(normalizePartName("/word/my%20file (1).xml")).toBe("/word/my%20file (1).xml");
    expect(normalizePartName("[Content_Types].xml")).toBe("/[Content_Types].xml");
  });

  it.each(["", "/", "//", "/a//b", "/a/", "a/./b", "a/../b", "..", ".", "a\\b", "a\u0000b"])("refuses %j", (name) => {
    expect(refused(() => normalizePartName(name))).toBe(true);
  });

  it("compares names without regard to ASCII case or to escaping of unreserved characters", () => {
    expect(partNamesEqual("/word/Document.xml", "WORD/document.XML")).toBe(true);
    expect(partNamesEqual("/word/a%2Db.xml", "/word/a-b.xml")).toBe(true);
    expect(partNamesEqual("/word/a%2fb.xml", "/word/a%2Fb.xml")).toBe(true);
    // An escaped slash is not a path separator, and a space is not its escape.
    expect(partNamesEqual("/word/a%2Fb.xml", "/word/a/b.xml")).toBe(false);
    expect(partNamesEqual("/word/a%20b.xml", "/word/a b.xml")).toBe(false);
    expect(partNamesEqual("/word/é.xml", "/word/É.xml")).toBe(false);
    expect(partNameKey("Word/Document.XML")).toBe("/word/document.xml");
  });

  it("maps between part names and archive entry names", () => {
    expect(partNameToEntryName("/word/document.xml")).toBe("word/document.xml");
    expect(entryNameToPartName("word/document.xml")).toBe("/word/document.xml");
  });

  it("extracts the extension and directory", () => {
    expect(partExtension("/word/media/Image1.PNG")).toBe("png");
    expect(partExtension("/word/document.xml.rels")).toBe("rels");
    expect(partExtension("/word.v2/noextension")).toBe("");
    expect(partExtension("/_rels/.rels")).toBe("rels");
    // The same spelling rules as part lookup: unreserved escapes decode, other escapes stay.
    expect(partExtension("/word/document.%78ml")).toBe("xml");
    expect(partExtension("/word/document.%58ML")).toBe("xml");
    expect(partExtension("/word/document%2Expm")).toBe("xpm");
    expect(partExtension("/word/media/a.x%2fy")).toBe("x%2fy");
    expect(partDirectory("/word/media/image1.png")).toBe("/word/media/");
    expect(partDirectory("/top.xml")).toBe("/");
  });
});

describe("relationships part names", () => {
  it("derives the relationships part of a source and back", () => {
    expect(relationshipsPartNameFor("/")).toBe("/_rels/.rels");
    expect(relationshipsPartNameFor("/word/document.xml")).toBe("/word/_rels/document.xml.rels");
    expect(relationshipsPartNameFor("top.xml")).toBe("/_rels/top.xml.rels");
    expect(relationshipsSourceOf("/_rels/.rels")).toBe("/");
    expect(relationshipsSourceOf("/word/_rels/document.xml.rels")).toBe("/word/document.xml");
    expect(relationshipsSourceOf("/_rels/top.xml.rels")).toBe("/top.xml");
    expect(relationshipsSourceOf("/word/document.xml")).toBeNull();
    expect(relationshipsSourceOf("/word/_rels/.rels")).toBeNull();
  });

  it("recognises relationships parts", () => {
    expect(isRelationshipsPartName("/_rels/.rels")).toBe(true);
    expect(isRelationshipsPartName("/xl/worksheets/_rels/sheet1.xml.rels")).toBe(true);
    expect(isRelationshipsPartName("/xl/_RELS/workbook.xml.RELS")).toBe(true);
    expect(isRelationshipsPartName("/word/document.xml")).toBe(false);
    expect(isRelationshipsPartName("/word/rels/document.xml.rels")).toBe(false);
    expect(isRelationshipsPartName("/word/_rels/sub/x.rels")).toBe(false);
  });

  it("recognises relationships parts whose unreserved characters are percent-escaped", () => {
    expect(isRelationshipsPartName("/word/%5Frels/document.xml.rels")).toBe(true);
    expect(isRelationshipsPartName("/word/_rels/document.xml%2erels")).toBe(true);
    expect(isRelationshipsPartName("/%5Frels/%2Erels")).toBe(true);
    // A reserved character stays escaped, so this is a different name.
    expect(isRelationshipsPartName("/word/_rels%2Fdocument.xml.rels")).toBe(false);
    expect(relationshipsSourceOf("/word/%5Frels/document.xml.rels")).toBe("/word/document.xml");
    expect(relationshipsSourceOf("/%5Frels/.rels")).toBe("/");
  });

  it("resolves relative, absolute and dotted targets", () => {
    expect(resolveRelationshipTarget("/xl/worksheets/sheet1.xml", "../drawings/drawing1.xml")).toBe("/xl/drawings/drawing1.xml");
    expect(resolveRelationshipTarget("/xl/workbook.xml", "worksheets/sheet1.xml")).toBe("/xl/worksheets/sheet1.xml");
    expect(resolveRelationshipTarget("/xl/workbook.xml", "/xl/./styles.xml")).toBe("/xl/styles.xml");
    expect(resolveRelationshipTarget("/xl/workbook.xml", "sharedStrings.xml?x=1#frag")).toBe("/xl/sharedStrings.xml");
    expect(resolveRelationshipTarget("/", "docProps/core.xml")).toBe("/docProps/core.xml");
    expect(refused(() => resolveRelationshipTarget("/xl/workbook.xml", "../../etc/passwd"))).toBe(true);
    expect(refused(() => resolveRelationshipTarget("/xl/workbook.xml", "/../etc/passwd"))).toBe(true);
    expect(refused(() => resolveRelationshipTarget("/xl/workbook.xml", "a\\b.xml"))).toBe(true);
    expect(refused(() => resolveRelationshipTarget("/xl/workbook.xml", ""))).toBe(true);
  });

  it("writes a target relative to its source that resolves back to the part", () => {
    const cases: [string, string, string][] = [
      ["/word/document.xml", "/word/media/image1.png", "media/image1.png"],
      ["/word/document.xml", "/customXml/item1.xml", "../customXml/item1.xml"],
      ["/xl/worksheets/sheet1.xml", "/xl/drawings/drawing1.xml", "../drawings/drawing1.xml"],
      ["/", "/word/document.xml", "word/document.xml"],
      ["/word/document.xml", "/word/styles.xml", "styles.xml"],
      ["/a/b/c.xml", "/a/b", "../b"],
    ];
    for (const [source, part, relative] of cases) {
      expect(relativeTargetFor(source, part)).toBe(relative);
      expect(resolveRelationshipTarget(source, relative)).toBe(part);
    }
  });
});
