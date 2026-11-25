import { describe, expect, it } from "vitest";
import type { XmlElement } from "../../../packages/office/src/api/xml.js";
import { isOfficeError, type OfficeError } from "../../../packages/office/src/errors.js";
import {
  DEFAULT_XML_LIMITS,
  cloneNode,
  find,
  findAll,
  parseXml,
  serializeXml,
  textContent,
} from "../../../packages/office/src/xml/index.js";

function failure(action: () => unknown): OfficeError {
  try {
    action();
  } catch (error) {
    if (isOfficeError(error)) return error;
    throw error;
  }
  throw new Error("expected the parser to refuse this input");
}

describe("document type declarations", () => {
  const attacks: ReadonlyArray<readonly [string, string]> = [
    [
      "nested entity expansion",
      '<?xml version="1.0"?>\n<!DOCTYPE lolz [\n <!ENTITY lol "lol">\n <!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">\n <!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;">\n]>\n<lolz>&lol3;</lolz>',
    ],
    ["external entity", '<!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><foo>&xxe;</foo>'],
    ["parameter entity", '<!DOCTYPE foo [<!ENTITY % ext SYSTEM "http://example.invalid/x.dtd"> %ext;]><foo/>'],
    ["external subset", '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Strict//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-strict.dtd"><html/>'],
    ["empty declaration", "<!DOCTYPE a><a/>"],
    ["declaration after the document element", "<a/><!DOCTYPE a>"],
    ["declaration inside the document element", "<a><!DOCTYPE a></a>"],
    ["lower-case spelling", "<!doctype a><a/>"],
    ["bare entity declaration", '<!ENTITY x "y"><a/>'],
    ["bare element declaration", "<a><!ELEMENT a ANY></a>"],
  ];

  for (const [name, source] of attacks) {
    it(`refuses ${name}`, () => {
      const error = failure(() => parseXml(source));
      expect(error.code).toBe("malformed_xml");
      expect(error.details.offset).toBe(source.indexOf("<!"));
    });
  }

  it("names the reason so callers can tell a DTD from a syntax error", () => {
    expect(failure(() => parseXml("<!DOCTYPE a><a/>")).details.reason).toBe("doctype");
  });
});

describe("entity references", () => {
  const undefinedEntities = ["&xxe;", "&nbsp;", "&lol3;", "&copy;", "&AMP;", "&Lt;", "&;", "& ", "&amp", "&#;", "&#x;", "&#xZZ;", "&#12a;", "&#-1;", "&# 65;"];

  for (const reference of undefinedEntities) {
    it(`refuses ${JSON.stringify(reference)} in text and in an attribute`, () => {
      const inText = `<a>ok ${reference} tail</a>`;
      const textError = failure(() => parseXml(inText));
      expect(textError.code).toBe("malformed_xml");
      expect(textError.details.offset).toBe(inText.indexOf("&"));

      const inAttr = `<a b="ok ${reference} tail"/>`;
      const attrError = failure(() => parseXml(inAttr));
      expect(attrError.code).toBe("malformed_xml");
      expect(attrError.details.offset).toBe(inAttr.indexOf("&"));
    });
  }

  it("marks an undefined entity with a reason", () => {
    expect(failure(() => parseXml("<a>&xxe;</a>")).details.reason).toBe("undefined_entity");
  });

  it("refuses character references to characters XML forbids", () => {
    for (const reference of ["&#0;", "&#x0;", "&#8;", "&#xB;", "&#x1F;", "&#xD800;", "&#xDFFF;", "&#xFFFE;", "&#xFFFF;", "&#x110000;", "&#99999999999999999999;", `&#x${"F".repeat(4000)};`]) {
      const source = `<a>${reference}</a>`;
      const error = failure(() => parseXml(source));
      expect(error.code).toBe("malformed_xml");
      expect(error.details.offset).toBe(3);
    }
  });

  it("accepts the five predefined entities and valid character references", () => {
    const doc = parseXml("<a b='&lt;&gt;&amp;&quot;&apos;'>&lt;&gt;&amp;&quot;&apos;&#x9;&#xA;&#xD;&#x20;&#xD7FF;&#xE000;&#xFFFD;&#x10000;&#x10FFFF;&#00065;&#x000041;</a>");
    expect(doc.root.attrs[0]?.value).toBe("<>&\"'");
    expect(textContent(doc.root)).toBe("<>&\"'\t\n\r ퟿�\u{10000}\u{10ffff}AA");
  });

  it("never expands text: a decoded ampersand is not decoded twice", () => {
    const doc = parseXml("<a>&amp;lt; &amp;#65; &#38;amp;</a>");
    expect(textContent(doc.root)).toBe("&lt; &#65; &amp;");
  });
});

describe("forbidden characters", () => {
  it("refuses control characters in the source", () => {
    for (const char of ["\u0000", "\u0001", "\u0008", "\u000b", "\u000c", "\u000e", "\u001f", "￾", "￿"]) {
      for (const source of [`<a>x${char}</a>`, `<a b="x${char}"/>`, `<a><!--x${char}--></a>`, `<a><![CDATA[x${char}]]></a>`]) {
        const error = failure(() => parseXml(source));
        expect(error.code).toBe("malformed_xml");
        expect(error.details.offset).toBe(source.indexOf(char));
      }
    }
  });

  it("accepts tab, line feed and carriage return", () => {
    const source = "<a b='\t\n\r'>\t\n\r</a>";
    expect(serializeXml(parseXml(source))).toBe(source);
  });
});

describe("depth guard", () => {
  const nested = (depth: number): string => "<a>".repeat(depth) + "</a>".repeat(depth);

  it("publishes frozen defaults", () => {
    expect(DEFAULT_XML_LIMITS).toEqual({ maxDepth: 512, maxNodes: 2_000_000 });
    expect(Object.isFrozen(DEFAULT_XML_LIMITS)).toBe(true);
  });

  it("accepts the default depth and refuses one level more", () => {
    expect(serializeXml(parseXml(nested(512)))).toBe(nested(512));
    const error = failure(() => parseXml(nested(513)));
    expect(error.code).toBe("limit_exceeded");
    expect(error.details.limit).toBe("maxDepth");
    expect(error.details.max).toBe(512);
    expect(error.details.offset).toBe(512 * 3);
  });

  it("counts a self-closing element as a level", () => {
    expect(() => parseXml("<a><b><c/></b></a>", { maxDepth: 3 })).not.toThrow();
    expect(failure(() => parseXml("<a><b><c/></b></a>", { maxDepth: 2 })).code).toBe("limit_exceeded");
    expect(() => parseXml("<a><b/><b/><b><c/></b></a>", { maxDepth: 3 })).not.toThrow();
  });

  it("refuses a very deep hostile document quickly", () => {
    const hostile = "<a>".repeat(2_000_000);
    const started = performance.now();
    const error = failure(() => parseXml(hostile));
    expect(error.code).toBe("limit_exceeded");
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it("walks a very deep tree without recursion when the caller raises the limit", () => {
    const depth = 300_000;
    const source = "<a>".repeat(depth - 1) + "<a k='v'>leaf</a>" + "</a>".repeat(depth - 1);
    const doc = parseXml(source, { maxDepth: depth });
    expect(serializeXml(doc)).toBe(source);
    expect(textContent(doc.root)).toBe("leaf");
    expect(findAll(doc, "a")).toHaveLength(depth);
    const copy = cloneNode(doc.root);
    expect(serializeXml(copy)).toBe(source);
    const inner = find(doc.root, "a") as XmlElement;
    expect(inner.parent).toBe(doc.root);
  });
});

describe("node count guard", () => {
  it("counts every kind of node", () => {
    const source = "<?xml version='1.0'?><a><b/>t<!--c--><![CDATA[d]]><?p?></a>";
    expect(() => parseXml(source, { maxNodes: 7 })).not.toThrow();
    const error = failure(() => parseXml(source, { maxNodes: 6 }));
    expect(error.code).toBe("limit_exceeded");
    expect(error.details.limit).toBe("maxNodes");
    expect(error.details.max).toBe(6);
  });

  it("refuses a flood of tiny elements", () => {
    const flood = `<a>${"<b/>".repeat(50_000)}</a>`;
    expect(() => parseXml(flood, { maxNodes: 50_001 })).not.toThrow();
    expect(failure(() => parseXml(flood, { maxNodes: 50_000 })).code).toBe("limit_exceeded");
  });

  it("refuses limits that are not usable numbers", () => {
    for (const limits of [{ maxDepth: 0 }, { maxDepth: -1 }, { maxNodes: Number.NaN }, { maxNodes: 1.5 }, { maxDepth: "9" as unknown as number }]) {
      expect(failure(() => parseXml("<a/>", limits)).code).toBe("invalid_argument");
    }
  });

  it("handles an element with a very large number of attributes in linear time", () => {
    let source = "<a";
    for (let index = 0; index < 60_000; index++) source += ` a${index}="${index}"`;
    source += "/>";
    const started = performance.now();
    const doc = parseXml(source);
    expect(performance.now() - started).toBeLessThan(2000);
    expect(doc.root.attrs).toHaveLength(60_000);
    expect(serializeXml(doc)).toBe(source);
    const duplicate = source.replace(' a59999="59999"', ' a7="again"');
    const error = failure(() => parseXml(duplicate));
    expect(error.code).toBe("malformed_xml");
    expect(error.details.offset).toBe(duplicate.indexOf('a7="again"'));
  });
});
