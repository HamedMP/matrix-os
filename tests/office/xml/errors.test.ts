import { describe, expect, it } from "vitest";
import { isOfficeError, type OfficeError } from "../../../packages/office/src/errors.js";
import { parseXml } from "../../../packages/office/src/xml/index.js";

function failure(source: string): OfficeError {
  try {
    parseXml(source);
  } catch (error) {
    if (isOfficeError(error)) return error;
    throw error;
  }
  throw new Error(`expected a parse error for ${JSON.stringify(source)}`);
}

/** `^` marks the offset the error must report; it is removed from the input. */
function marked(source: string): { text: string; offset: number } {
  const offset = source.indexOf("^");
  if (offset === -1) throw new Error("missing ^ marker");
  return { text: source.slice(0, offset) + source.slice(offset + 1), offset };
}

describe("malformed input", () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ["empty input", "^"],
    ["whitespace only", "  \n^"],
    ["only a declaration", '<?xml version="1.0"?>^'],
    ["only a comment", "<!-- nothing -->^"],
    ["text before the document element", "^hello<a/>"],
    ["text after the document element", "<a/> ^x"],
    ["a reference outside the document element", "<a/>^&#32;"],
    ["a second document element", "<a/>^<b/>"],
    ["an element left open", "<a><b></b>^"],
    ["an element left open with trailing text", "<a>text^"],
    ["a mismatched end tag", "<a><b>^</c></a>"],
    ["an end tag with a longer name", "<a>^</ab>"],
    ["an end tag with no start tag", "<a/>^</a>"],
    ["an end tag that is cut off", "<a>^</a"],
    ["a space before the end tag name", "<a>^</ a>"],
    ["a stray less-than sign", "<a>1 ^< 2</a>"],
    ["a tag name starting with a digit", "<a>^<1b/></a>"],
    ["a tag that is cut off after the name", "<a^"],
    ["a tag that is cut off inside the attributes", '<a b="1" ^'],
    ["an attribute without a value", "<a b^></a>"],
    ["an attribute without quotes", "<a b=^1/>"],
    ["an attribute value that never ends", '<a b="1^'],
    ["a less-than sign in an attribute value", '<a b="1^<2"/>'],
    ["attributes with no space between them", '<a b="1"^c="2"/>'],
    ["a duplicate attribute", '<a b="1" ^b="2"/>'],
    ["a duplicate among many attributes", '<a a1="" a2="" a3="" a4="" a5="" a6="" a7="" a8="" a9="" a10="" ^a2=""/>'],
    ["a slash that does not close the tag", "<a ^/ >"],
    ["an attribute name starting with a hyphen", '<a ^-b="1"/>'],
    ["a comment that never ends", "<a>^<!-- open</a>"],
    ["a double hyphen inside a comment", "<a><!-- a ^-- b --></a>"],
    ["a comment ending in three hyphens", "<a><!-- a ^---></a>"],
    ["a CDATA section that never ends", "<a>^<![CDATA[open</a>"],
    ["a CDATA section outside the document element", "^<![CDATA[x]]><a/>"],
    ["a processing instruction that never ends", "<a>^<?pi data</a>"],
    ["a processing instruction without a target", "<a>^<? data?></a>"],
    ["a processing instruction with a bad separator", "<a><?pi^=data?></a>"],
    ["a declaration after whitespace", ' ^<?xml version="1.0"?><a/>'],
    ["a declaration inside the document element", '<a>^<?xml version="1.0"?></a>'],
    ["a declaration with a reserved-case target", "<a>^<?XML version='1.0'?></a>"],
    ["a declaration without a version", '^<?xml encoding="UTF-8"?><a/>'],
    ["a declaration with an unknown version", '^<?xml version="2.0"?><a/>'],
    ["a declaration with attributes out of order", '^<?xml version="1.0" standalone="yes" encoding="UTF-8"?><a/>'],
    ["a declaration with a bad standalone value", '^<?xml version="1.0" standalone="maybe"?><a/>'],
    ["a declaration with an unknown attribute", '^<?xml version="1.0" charset="x"?><a/>'],
    ["a declaration that never ends", '^<?xml version="1.0"<a/>'],
    ["an unknown markup declaration", "<a>^<!FOO></a>"],
  ];

  for (const [name, source] of cases) {
    it(`reports ${name} with its position`, () => {
      const { text, offset } = marked(source);
      const error = failure(text);
      expect(error.code).toBe("malformed_xml");
      expect(error.details.offset).toBe(offset);
      expect(error.name).toBe("OfficeError");
    });
  }

  it("reports line and column, counting from one", () => {
    const error = failure('<a>\n  <b c="1"\n     c="2"/>\n</a>');
    expect(error.details.line).toBe(3);
    expect(error.details.column).toBe(6);
    expect(error.details.offset).toBe(20);
    expect(error.message).toContain("line 3");

    const first = failure("x");
    expect(first.details.line).toBe(1);
    expect(first.details.column).toBe(1);
  });

  it("counts a byte order mark in the reported offset", () => {
    const error = failure("﻿<a>&bad;</a>");
    expect(error.details.offset).toBe(4);
    expect(error.details.column).toBe(5);
  });

  it("keeps long hostile names out of the error message", () => {
    const name = "n".repeat(100_000);
    const error = failure(`<${name}></x>`);
    expect(error.code).toBe("malformed_xml");
    expect(error.message.length).toBeLessThan(400);
  });

  it("refuses input that is not a string", () => {
    for (const value of [null, undefined, 42, new Uint8Array(4), {}]) {
      let thrown: unknown = null;
      try {
        parseXml(value as unknown as string);
      } catch (error) {
        thrown = error;
      }
      expect(isOfficeError(thrown, "invalid_argument")).toBe(true);
    }
  });

  it("serialises to a client-safe shape", () => {
    const error = failure("<a>&secret;</a>");
    expect(JSON.parse(JSON.stringify(error))).toEqual({ name: "OfficeError", code: "malformed_xml" });
  });
});
