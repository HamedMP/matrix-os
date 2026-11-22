import { describe, expect, it } from "vitest";
import type { XmlElement, XmlText } from "../../../packages/office/src/api/xml.js";
import { isOfficeError } from "../../../packages/office/src/errors.js";
import {
  child,
  children,
  find,
  getAttr,
  parseXml,
  serializeXml,
  textContent,
} from "../../../packages/office/src/xml/index.js";
import { KITCHEN_SINK, SAMPLES, SHARED_STRINGS, SHEET, UNICODE, WORD_DOCUMENT, seededRandom } from "./corpus.js";

describe("exact round-trip", () => {
  for (const sample of SAMPLES) {
    it(`reproduces ${sample.name} character for character`, () => {
      expect(serializeXml(parseXml(sample.xml))).toBe(sample.xml);
    });
  }

  it("serialises one element as the exact source text of that element", () => {
    const doc = parseXml(WORD_DOCUMENT);
    const ins = find(doc, "w:ins") as XmlElement;
    const start = WORD_DOCUMENT.indexOf("<w:ins ");
    const end = WORD_DOCUMENT.indexOf("</w:ins>") + "</w:ins>".length;
    expect(serializeXml(ins)).toBe(WORD_DOCUMENT.slice(start, end));
  });

  it("keeps a second parse of the output identical to the first", () => {
    const once = serializeXml(parseXml(KITCHEN_SINK));
    expect(serializeXml(parseXml(once))).toBe(once);
  });

  it("round-trips generated documents with random lexical choices", () => {
    const random = seededRandom(20260107);
    const pick = <T,>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
    const names = ["a", "w:p", "w:r", "x-y", "_n", "c.d", "mc:Choice", "é"];
    const spaces = ["", " ", "  ", "\n", "\t", "\r\n "];
    const values = ["", "1", "a b", "&amp;", "&#10;x", "it&apos;s", "x>y", "&#x1F600;", "\ttab"];
    const texts = ["", "plain", " ", "\n  ", "a &amp; b", "&lt;tag&gt;", "&#169; 2026", "x ]] y", "'quoted' \"text\""];

    const build = (depth: number): string => {
      const name = pick(names);
      let tag = `<${name}`;
      const used = new Set<string>();
      for (let i = Math.floor(random() * 4); i > 0; i--) {
        const attrName = pick(names);
        if (used.has(attrName)) continue;
        used.add(attrName);
        const quote = pick(['"', "'"]);
        tag += `${pick(spaces) || " "}${attrName}${pick(spaces)}=${pick(spaces)}${quote}${pick(values)}${quote}`;
      }
      tag += pick(spaces);
      const shape = random();
      if (shape < 0.25) return `${tag}/>`;
      let body = "";
      if (shape >= 0.4) {
        for (let i = Math.floor(random() * 5); i > 0; i--) {
          const kind = random();
          if (kind < 0.35 && depth < 6) body += build(depth + 1);
          else if (kind < 0.7) body += pick(texts);
          else if (kind < 0.8) body += `<!--${pick(["", " note ", "a - b", "<x>&"])}-->`;
          else if (kind < 0.9) body += `<![CDATA[${pick(["", "<raw>&", "]] >", "a]b"])}]]>`;
          else body += `<?${pick(["pi", "mso-x"])}${pick(["", " data", " a?b"])}?>`;
        }
      }
      return `${tag}>${body}</${name}${pick(spaces)}>`;
    };

    for (let round = 0; round < 400; round++) {
      const prolog = pick(["", '<?xml version="1.0"?>', "<?xml version='1.0' encoding='UTF-8' standalone=\"yes\" ?>\n"]);
      const source = `${prolog}${pick(["", "\n", "<!-- c -->"])}${build(0)}${pick(["", "\n", "<!--end-->\n", "<?done?>"])}`;
      expect(serializeXml(parseXml(source))).toBe(source);
    }
  });

  it("either rejects a damaged document with a typed error or reproduces it exactly", () => {
    const random = seededRandom(424242);
    const alphabet = ["<", ">", "/", "&", ";", '"', "'", "=", " ", "!", "?", "-", "[", "]", "#", "x", "a", ":"];
    let accepted = 0;
    let rejected = 0;
    for (const sample of [KITCHEN_SINK, SHEET, WORD_DOCUMENT, UNICODE]) {
      for (let round = 0; round < 1500; round++) {
        const at = Math.floor(random() * sample.length);
        const mode = random();
        const insert = alphabet[Math.floor(random() * alphabet.length)] as string;
        const damaged =
          mode < 0.34
            ? sample.slice(0, at) + insert + sample.slice(at)
            : mode < 0.67
              ? sample.slice(0, at) + sample.slice(at + 1)
              : sample.slice(0, at) + insert + sample.slice(at + 1);
        let output: string | null = null;
        try {
          output = serializeXml(parseXml(damaged));
        } catch (error) {
          expect(isOfficeError(error, "malformed_xml")).toBe(true);
          const offset = (error as { details: { offset?: unknown } }).details.offset;
          expect(typeof offset).toBe("number");
          expect(offset as number).toBeGreaterThanOrEqual(0);
          expect(offset as number).toBeLessThanOrEqual(damaged.length);
          rejected++;
        }
        if (output !== null) {
          expect(output).toBe(damaged);
          accepted++;
        }
      }
    }
    expect(accepted).toBeGreaterThan(100);
    expect(rejected).toBeGreaterThan(100);
  });
});

describe("parsed tree", () => {
  it("keeps prefixes, attribute order and decoded values", () => {
    const doc = parseXml(WORD_DOCUMENT);
    expect(doc.root.name).toBe("w:document");
    expect(doc.root.parent).toBe(doc);
    expect(doc.bom).toBe(false);
    expect(doc.root.attrs.map((attr) => attr.name)).toEqual([
      "xmlns:wpc",
      "xmlns:mc",
      "xmlns:r",
      "xmlns:wp",
      "xmlns:w",
      "xmlns:w14",
      "xmlns:wps",
      "xmlns:v",
      "mc:Ignorable",
    ]);
    const del = find(doc, "w:del") as XmlElement;
    expect(getAttr(del, "w:author")).toBe("O'Neil & Co");
    expect(del.attrs[1]?.raw).toBe("O&apos;Neil &amp; Co");
    expect(textContent(find(doc, "w:ins") as XmlElement)).toBe('<amount> or "the cap" ');
    expect(textContent(del)).toBe("€1,000 ");
    const preserved = find(doc, "w:t", ) as XmlElement;
    expect(preserved.parent?.kind).toBe("element");
  });

  it("records the declaration, top-level nodes and the byte order mark", () => {
    const doc = parseXml("﻿" + KITCHEN_SINK);
    expect(doc.bom).toBe(true);
    const kinds = doc.children.map((node) => node.kind);
    expect(kinds).toEqual(["declaration", "text", "comment", "text", "pi", "text", "element", "text", "comment", "text", "pi", "text"]);
    const declaration = doc.children[0];
    if (declaration?.kind !== "declaration") throw new Error("expected a declaration");
    expect(declaration.version).toBe("1.0");
    expect(declaration.encoding).toBe("utf-8");
    expect(declaration.standalone).toBeNull();
    expect(declaration.raw).toBe("<?xml version='1.0'  encoding='utf-8'?>");
    expect(declaration.parent).toBe(doc);
    expect(doc.children[6]).toBe(doc.root);
    for (const node of doc.children) expect(node.parent).toBe(doc);
  });

  it("reads standalone and a missing encoding from the declaration", () => {
    const doc = parseXml("<?xml version='1.1' standalone='no' ?><a/>");
    const declaration = doc.children[0];
    if (declaration?.kind !== "declaration") throw new Error("expected a declaration");
    expect(declaration.version).toBe("1.1");
    expect(declaration.encoding).toBeNull();
    expect(declaration.standalone).toBe("no");
  });

  it("keeps quote style, spacing inside tags and the empty-element form", () => {
    const doc = parseXml(KITCHEN_SINK);
    const root = doc.root;
    expect(root.name).toBe("root");
    expect(root.attrs.map((attr) => [attr.lead, attr.name, attr.eq, attr.quote])).toEqual([
      ["  ", "xmlns", "=", "'"],
      ["\n\t", "xmlns:a", " = ", '"'],
      ["   ", "a:flag", "=", "'"],
      [" ", "empty", "=", '"'],
    ]);
    expect(root.openTagTail).toBe(" ");
    expect(root.closeTagTail).toBe(" ");
    expect(getAttr(root, "a:flag")).toBe('it\'s "on"');
    expect(getAttr(root, "empty")).toBe("");
    expect(getAttr(root, "missing")).toBeNull();

    const items = children(root, "a:item");
    expect(items.map((item) => [item.selfClosing, item.openTagTail, item.closeTagTail])).toEqual([
      [true, "", ""],
      [false, " ", " "],
      [true, "   ", ""],
    ]);
    for (const item of items) expect(item.parent).toBe(root);
  });

  it("decodes character references and predefined entities in text only", () => {
    const doc = parseXml(KITCHEN_SINK);
    const text = child(doc.root, "text") as XmlElement;
    const node = text.children[0] as XmlText;
    expect(node.kind).toBe("text");
    expect(node.value).toBe("ABC &amp; tab\tlf\ncr\r nbsp end ]] > done");
    expect(node.raw).toBe("&#65;&#x42;&#x0043; &amp;amp; tab&#9;lf&#10;cr&#13; nbsp&#xA0;end ]] > done");

    const cdata = doc.root.children.filter((entry) => entry.kind === "cdata");
    expect(cdata.map((entry) => entry.value)).toEqual(['if (a < b && c > d) { x = "]]"; }', ""]);
    const comments = doc.root.children.filter((entry) => entry.kind === "comment");
    expect(comments.map((entry) => entry.value)).toEqual(["", " a comment with <tags> & ampersands "]);
    const instructions = doc.root.children.filter((entry) => entry.kind === "pi");
    expect(instructions.map((entry) => [entry.target, entry.data])).toEqual([
      ["pi", ""],
      ["target", " some data ? > still data"],
    ]);
  });

  it("does not normalise line endings or whitespace in attribute values", () => {
    const doc = parseXml(KITCHEN_SINK);
    const multi = child(doc.root, "multi") as XmlElement;
    expect(getAttr(multi, "line")).toBe("first\n\tsecond");
    expect(getAttr(multi, "gt")).toBe("a>b");
    const crlf = parseXml("<a>one\r\ntwo</a>");
    expect((crlf.root.children[0] as XmlText).value).toBe("one\r\ntwo");
  });

  it("keeps whitespace-only text, with or without xml:space", () => {
    const strings = parseXml(SHARED_STRINGS);
    const items = children(strings.root, "si");
    const blank = child(items[1] as XmlElement, "t") as XmlElement;
    expect(getAttr(blank, "xml:space")).toBe("preserve");
    expect(blank.children).toHaveLength(1);
    expect(textContent(blank)).toBe(" ");
    expect(textContent(items[2] as XmlElement)).toBe("line one_x000D_\nline two");
    expect(textContent(items[3] as XmlElement)).toBe("plain bold & red");

    const padded = find(parseXml(SHEET), "is") as XmlElement;
    expect(textContent(padded)).toBe("  padded  ");

    const pretty = parseXml("<a>\n  <b/>\n</a>");
    expect(pretty.root.children.map((node) => node.kind)).toEqual(["text", "element", "text"]);
    expect((pretty.root.children[0] as XmlText).value).toBe("\n  ");
  });

  it("decodes characters outside the basic multilingual plane", () => {
    const doc = parseXml(UNICODE);
    expect(doc.root.name).toBe("文書");
    expect(getAttr(doc.root, "emoji")).toBe("😀👍🏽");
    expect(textContent(child(doc.root, "math") as XmlElement)).toBe("𝒜 ⊂ ℝ³ 😀 😀");
  });

  it("shares one string for a value that needs no decoding", () => {
    const doc = parseXml('<a b="plain">words</a>');
    const attr = doc.root.attrs[0];
    expect(attr?.raw).toBe("plain");
    expect(attr?.value).toBe("plain");
    const text = doc.root.children[0] as XmlText;
    expect(text.raw).toBe("words");
    expect(text.value).toBe("words");
  });
});
