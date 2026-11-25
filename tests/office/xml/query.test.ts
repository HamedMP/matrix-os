import { describe, expect, it } from "vitest";
import type { XmlElement, XmlModule } from "../../../packages/office/src/api/xml.js";
import * as xml from "../../../packages/office/src/xml/index.js";
import {
  child,
  children,
  createElement,
  createText,
  find,
  findAll,
  getAttr,
  isWhitespaceText,
  localName,
  lookupNamespace,
  lookupPrefix,
  namespaceOf,
  parseXml,
  prefixOf,
  setAttr,
  textContent,
} from "../../../packages/office/src/xml/index.js";
import { KITCHEN_SINK, SHEET, WORD_DOCUMENT } from "./corpus.js";

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const MC = "http://schemas.openxmlformats.org/markup-compatibility/2006";
const SHEET_MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";

describe("contract", () => {
  it("exports every value the contract names", () => {
    const names: ReadonlyArray<keyof XmlModule> = [
      "parseXml",
      "serializeXml",
      "child",
      "children",
      "find",
      "findAll",
      "getAttr",
      "setAttr",
      "removeAttr",
      "createElement",
      "createText",
      "appendChild",
      "prependChild",
      "insertBefore",
      "insertAfter",
      "remove",
      "replaceNode",
      "cloneNode",
      "cloneDocument",
      "textContent",
      "setTextContent",
      "setText",
      "isWhitespaceText",
      "localName",
      "prefixOf",
      "lookupNamespace",
      "escapeXmlText",
      "escapeXmlAttr",
    ];
    const module: Record<string, unknown> = xml;
    for (const name of names) expect(typeof module[name]).toBe("function");
    expect(typeof module.DEFAULT_XML_LIMITS).toBe("object");
    for (const name of names) expect(xml.xmlModule[name]).toBe(module[name]);
    expect(xml.xmlModule.DEFAULT_XML_LIMITS).toBe(xml.DEFAULT_XML_LIMITS);
  });
});

describe("queries", () => {
  it("finds direct children by qualified name", () => {
    const doc = parseXml(WORD_DOCUMENT);
    const body = child(doc.root, "w:body") as XmlElement;
    expect(body.name).toBe("w:body");
    expect(child(doc.root, "body")).toBeNull();
    expect(child(doc.root, "w:p")).toBeNull();
    expect(children(body, "w:p")).toHaveLength(3);
    expect(children(body).map((element) => element.name)).toEqual(["w:p", "w:p", "w:p", "w:tbl", "w:sectPr"]);
    expect(children(body, "w:none")).toEqual([]);
  });

  it("skips text, comments and other non-element children", () => {
    const doc = parseXml(KITCHEN_SINK);
    expect(children(doc.root).map((element) => element.name)).toEqual(["a:item", "a:item", "a:item", "text", "multi", "deep"]);
  });

  it("finds descendants in document order and never the start element", () => {
    const doc = parseXml(WORD_DOCUMENT);
    expect(find(doc, "w:document")).toBe(doc.root);
    expect(find(doc.root, "w:document")).toBeNull();
    const paragraphs = findAll(doc, "w:p");
    expect(paragraphs).toHaveLength(5);
    expect(find(doc, "w:p")).toBe(paragraphs[0]);
    const texts = findAll(doc, "w:t").map((element) => textContent(element));
    expect(texts).toEqual(["Terms & Conditions", "The supplier’s liability is limited to ", '<amount> or "the cap" ', "end."]);
    expect(findAll(doc, "w:missing")).toEqual([]);
    expect(find(doc, "w:missing")).toBeNull();

    const nested = parseXml("<a><a id='1'><a id='2'/></a><a id='3'/></a>");
    expect(findAll(nested.root, "a").map((element) => getAttr(element, "id"))).toEqual(["1", "2", "3"]);
    expect(findAll(nested, "a")).toHaveLength(4);
  });

  it("reads markup-compatibility branches like any other element", () => {
    const doc = parseXml(WORD_DOCUMENT);
    const alternate = find(doc, "mc:AlternateContent") as XmlElement;
    const choice = child(alternate, "mc:Choice") as XmlElement;
    expect(getAttr(choice, "Requires")).toBe("wps");
    expect(children(alternate).map((element) => element.name)).toEqual(["mc:Choice", "mc:Fallback"]);
    expect(find(alternate, "v:rect")).not.toBeNull();
  });

  it("concatenates text and CDATA", () => {
    const doc = parseXml("<a>one <b>two<![CDATA[ <3> ]]></b><!-- no --><?no no?> four &amp; five</a>");
    expect(textContent(doc.root)).toBe("one two <3>  four & five");
    const b = child(doc.root, "b") as XmlElement;
    expect(textContent(b.children[0] as never)).toBe("two");
    expect(textContent(b.children[1] as never)).toBe(" <3> ");
    expect(textContent(createElement("empty"))).toBe("");
  });

  it("recognises whitespace-only text", () => {
    const doc = parseXml("<a> \t\r\n<b/>x <!-- --><![CDATA[ ]]>&#32;</a>");
    expect(doc.root.children.map((node) => isWhitespaceText(node))).toEqual([true, false, false, false, false, true]);
    expect(isWhitespaceText(createText(""))).toBe(true);
    expect(isWhitespaceText(createText(" "))).toBe(false);
    expect(isWhitespaceText(doc.root)).toBe(false);
  });

  it("reads attributes by qualified name only", () => {
    const doc = parseXml(SHEET);
    const cell = find(doc, "c") as XmlElement;
    expect(getAttr(cell, "r")).toBe("A1");
    expect(getAttr(cell, "t")).toBe("s");
    expect(getAttr(cell, "x:r")).toBeNull();
    const format = find(doc, "sheetFormatPr") as XmlElement;
    expect(getAttr(format, "x14ac:dyDescent")).toBe("0.25");
    expect(getAttr(format, "dyDescent")).toBeNull();
  });
});

describe("names and namespaces", () => {
  it("splits qualified names", () => {
    expect(localName("w:p")).toBe("p");
    expect(prefixOf("w:p")).toBe("w");
    expect(localName("sheetData")).toBe("sheetData");
    expect(prefixOf("sheetData")).toBe("");
    expect(localName("xmlns:w")).toBe("w");
    expect(prefixOf("xmlns:w")).toBe("xmlns");
  });

  it("resolves prefixes declared on an ancestor", () => {
    const doc = parseXml(WORD_DOCUMENT);
    const deep = find(doc, "wp:extent") as XmlElement;
    expect(lookupNamespace(deep, "w")).toBe(W);
    expect(lookupNamespace(deep, "mc")).toBe(MC);
    expect(lookupNamespace(deep, "wp")).toBe("http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing");
    expect(lookupNamespace(deep, "nope")).toBeNull();
    expect(lookupNamespace(deep, "")).toBeNull();
    expect(namespaceOf(deep)).toBe("http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing");
    expect(lookupPrefix(deep, W)).toBe("w");
    expect(lookupPrefix(deep, "urn:unknown")).toBeNull();
  });

  it("resolves the default namespace", () => {
    const doc = parseXml(SHEET);
    const cell = find(doc, "c") as XmlElement;
    expect(lookupNamespace(cell, "")).toBe(SHEET_MAIN);
    expect(namespaceOf(cell)).toBe(SHEET_MAIN);
    expect(lookupPrefix(cell, SHEET_MAIN)).toBe("");
    expect(lookupNamespace(cell, "x14ac")).toBe("http://schemas.microsoft.com/office/spreadsheetml/2009/9/ac");
  });

  it("honours redeclaration and removal on inner elements", () => {
    const doc = parseXml(
      "<a xmlns='urn:outer' xmlns:p='urn:p1' xmlns:q='urn:q'>" +
        "<b xmlns='' xmlns:p='urn:p2'><p:c/><d/></b>" +
        "<p:e xmlns:amp='urn:a&amp;b'/>" +
        "</a>",
    );
    const b = child(doc.root, "b") as XmlElement;
    const c = child(b, "p:c") as XmlElement;
    const d = child(b, "d") as XmlElement;
    const e = child(doc.root, "p:e") as XmlElement;
    expect(lookupNamespace(doc.root, "")).toBe("urn:outer");
    expect(lookupNamespace(b, "")).toBeNull();
    expect(namespaceOf(d)).toBeNull();
    expect(namespaceOf(c)).toBe("urn:p2");
    expect(namespaceOf(e)).toBe("urn:p1");
    expect(lookupNamespace(c, "q")).toBe("urn:q");
    expect(lookupNamespace(e, "amp")).toBe("urn:a&b");
    expect(lookupPrefix(c, "urn:p1")).toBeNull();
    expect(lookupPrefix(c, "urn:p2")).toBe("p");
    expect(lookupPrefix(d, "urn:outer")).toBeNull();
    expect(lookupPrefix(e, "urn:outer")).toBe("");
  });

  it("knows the two reserved prefixes", () => {
    const doc = parseXml("<a/>");
    expect(lookupNamespace(doc.root, "xml")).toBe("http://www.w3.org/XML/1998/namespace");
    expect(lookupNamespace(doc.root, "xmlns")).toBe("http://www.w3.org/2000/xmlns/");
  });

  it("sees declarations added through a helper and works on detached elements", () => {
    const element = createElement("w:p", { "xmlns:w": W });
    const run = createElement("w:r");
    expect(lookupNamespace(run, "w")).toBeNull();
    xml.appendChild(element, run);
    expect(lookupNamespace(run, "w")).toBe(W);
    setAttr(element, "xmlns:w", "urn:other");
    expect(namespaceOf(run)).toBe("urn:other");
  });
});
