import { describe, expect, it } from "vitest";
import type { XmlChildNode, XmlElement, XmlText } from "../../../packages/office/src/api/xml.js";
import { isOfficeError } from "../../../packages/office/src/errors.js";
import {
  appendChild,
  child,
  children,
  cloneDocument,
  cloneNode,
  createElement,
  createText,
  escapeXmlAttr,
  escapeXmlText,
  find,
  findAll,
  getAttr,
  insertAfter,
  insertBefore,
  parseXml,
  prependChild,
  remove,
  removeAttr,
  replaceNode,
  serializeXml,
  setAttr,
  setText,
  setTextContent,
  textContent,
} from "../../../packages/office/src/xml/index.js";
import { KITCHEN_SINK, SHEET, WORD_DOCUMENT } from "./corpus.js";

/** Replaces exactly one occurrence, failing the test when the anchor is not unique. */
function replaceOnce(source: string, before: string, after: string): string {
  const at = source.indexOf(before);
  if (at === -1 || source.indexOf(before, at + 1) !== -1) throw new Error(`anchor is not unique: ${before}`);
  return source.slice(0, at) + after + source.slice(at + before.length);
}

function expectCode(action: () => unknown, code: "invalid_operation" | "invalid_argument"): void {
  let thrown: unknown = null;
  try {
    action();
  } catch (error) {
    thrown = error;
  }
  expect(isOfficeError(thrown, code)).toBe(true);
}

describe("a mutation changes only the touched region", () => {
  it("rewrites one attribute value and nothing else", () => {
    const doc = parseXml(WORD_DOCUMENT);
    const ins = find(doc, "w:ins") as XmlElement;
    setAttr(ins, "w:author", 'R&D "Team" <legal>');
    expect(serializeXml(doc)).toBe(
      replaceOnce(WORD_DOCUMENT, 'w:author="Matrix Agent"', 'w:author="R&amp;D &quot;Team&quot; &lt;legal>"'),
    );
    expect(getAttr(ins, "w:author")).toBe('R&D "Team" <legal>');
    expect(ins.attrs[1]?.raw).toBeNull();
  });

  it("keeps the spelling of sibling attributes when one is edited", () => {
    const doc = parseXml(KITCHEN_SINK);
    setAttr(doc.root, "xmlns:a", "urn:b");
    expect(serializeXml(doc)).toBe(replaceOnce(KITCHEN_SINK, 'xmlns:a = "urn:a"', 'xmlns:a = "urn:b"'));
  });

  it("escapes the quote character the attribute is written with", () => {
    const doc = parseXml(KITCHEN_SINK);
    setAttr(doc.root, "a:flag", "it's \"off\"\n");
    expect(serializeXml(doc)).toBe(
      replaceOnce(KITCHEN_SINK, "a:flag='it&apos;s &quot;on&quot;'", "a:flag='it&apos;s \"off\"&#10;'"),
    );
    expect(getAttr(parseXml(serializeXml(doc)).root, "a:flag")).toBe("it's \"off\"\n");
  });

  it("appends a new attribute before the tag's trailing whitespace", () => {
    const doc = parseXml(KITCHEN_SINK);
    const second = children(doc.root, "a:item")[1] as XmlElement;
    setAttr(second, "a:new", "v");
    expect(serializeXml(doc)).toBe(
      replaceOnce(KITCHEN_SINK, "<a:item id='2' ></a:item >", "<a:item id='2' a:new=\"v\" ></a:item >"),
    );
  });

  it("removes an attribute and reports whether it existed", () => {
    const doc = parseXml(SHEET);
    const cell = findAll(doc, "c")[2] as XmlElement;
    expect(removeAttr(cell, "s")).toBe(true);
    expect(removeAttr(cell, "s")).toBe(false);
    expect(serializeXml(doc)).toBe(replaceOnce(SHEET, '<c r="C1" s="2">', '<c r="C1">'));
  });

  it("rewrites one text node and nothing else", () => {
    const doc = parseXml(WORD_DOCUMENT);
    const run = find(doc, "w:t") as XmlElement;
    setText(run.children[0] as XmlText, "Terms & <Conditions> v2");
    expect(serializeXml(doc)).toBe(
      replaceOnce(WORD_DOCUMENT, "<w:t>Terms &amp; Conditions</w:t>", "<w:t>Terms &amp; &lt;Conditions&gt; v2</w:t>"),
    );
    expect((run.children[0] as XmlText).raw).toBeNull();
  });

  it("replaces the content of a cell value", () => {
    const doc = parseXml(SHEET);
    const value = find(doc, "v") as XmlElement;
    setTextContent(value, "42");
    expect(serializeXml(doc)).toBe(replaceOnce(SHEET, '<c r="A1" t="s"><v>0</v>', '<c r="A1" t="s"><v>42</v>'));
    setTextContent(value, "");
    expect(value.children).toHaveLength(0);
    expect(serializeXml(doc)).toBe(replaceOnce(SHEET, '<c r="A1" t="s"><v>0</v>', '<c r="A1" t="s"><v></v>'));
  });

  it("inserts a new element between untouched siblings", () => {
    const doc = parseXml(SHEET);
    const rows = findAll(doc, "row");
    const cell = createElement("c", { r: "A9", t: "str" }, [createElement("v", undefined, ["a<b"])]);
    const row = createElement("row", [["r", "9"]], [cell]);
    insertAfter(rows[2] as XmlElement, row);
    const expected = replaceOnce(
      SHEET,
      "</row></sheetData>",
      '</row><row r="9"><c r="A9" t="str"><v>a&lt;b</v></c></row></sheetData>',
    );
    expect(serializeXml(doc)).toBe(expected);
    expect(row.parent).toBe(rows[0]?.parent);
    expect(cell.parent).toBe(row);
  });

  it("removes a subtree and leaves the rest byte for byte", () => {
    const doc = parseXml(WORD_DOCUMENT);
    const del = find(doc, "w:del") as XmlElement;
    const text = serializeXml(del);
    remove(del);
    expect(del.parent).toBeNull();
    expect(serializeXml(doc)).toBe(replaceOnce(WORD_DOCUMENT, text, ""));
    expect(serializeXml(del)).toBe(text);
    remove(del);
    expect(del.parent).toBeNull();
  });

  it("moves a parsed subtree without respelling it", () => {
    const doc = parseXml(SHEET);
    const rows = findAll(doc, "row");
    const first = rows[0] as XmlElement;
    const last = rows[2] as XmlElement;
    const firstText = serializeXml(first);
    const sheetData = first.parent as XmlElement;
    appendChild(sheetData, first);
    expect(sheetData.children.map((node) => (node as XmlElement).attrs[0]?.value)).toEqual(["2", "3", "1"]);
    expect(serializeXml(doc)).toBe(replaceOnce(SHEET.replace(firstText, ""), "</row></sheetData>", `</row>${firstText}</sheetData>`));
    insertBefore(last, first);
    prependChild(sheetData, first);
    expect(serializeXml(doc)).toBe(SHEET);
  });

  it("opens a self-closing element when it receives children", () => {
    const doc = parseXml("<a><b x='1' /></a>");
    const b = child(doc.root, "b") as XmlElement;
    appendChild(b, createText("t"));
    expect(serializeXml(doc)).toBe("<a><b x='1' >t</b></a>");
    remove(b.children[0] as XmlChildNode);
    expect(serializeXml(doc)).toBe("<a><b x='1' /></a>");
  });

  it("keeps the end tag of an element emptied after it was written open", () => {
    const doc = parseXml("<a><b>t</b></a>");
    const b = child(doc.root, "b") as XmlElement;
    remove(b.children[0] as XmlChildNode);
    expect(serializeXml(doc)).toBe("<a><b></b></a>");
  });

  it("replaces a node in place", () => {
    const doc = parseXml(WORD_DOCUMENT);
    const tab = find(doc, "w:tab") as XmlElement;
    const run = tab.parent as XmlElement;
    const position = run.children.indexOf(tab);
    const replacement = createElement("w:noBreakHyphen");
    replaceNode(tab, replacement);
    expect(tab.parent).toBeNull();
    expect(run.children[position]).toBe(replacement);
    expect(replacement.parent).toBe(run);
    expect(serializeXml(doc)).toBe(replaceOnce(WORD_DOCUMENT, "<w:tab/>", "<w:noBreakHyphen/>"));
  });
});

describe("new nodes", () => {
  it("writes created elements canonically", () => {
    const element = createElement("w:r", [["w:rsidR", "00AB"], ["xml:space", "preserve"]], [
      createElement("w:rPr", {}, [createElement("w:b")]),
      "a < b & c > d",
      createElement("w:t", { "xml:space": "preserve" }, [" tail\r\n"]),
      "",
    ]);
    expect(serializeXml(element)).toBe(
      '<w:r w:rsidR="00AB" xml:space="preserve"><w:rPr><w:b/></w:rPr>a &lt; b &amp; c &gt; d<w:t xml:space="preserve"> tail&#13;\n</w:t></w:r>',
    );
    // A literal carriage return would reach other readers as a line feed; the reference survives.
    expect(textContent(parseXml(serializeXml(element)).root)).toBe("a < b & c > d tail\r\n");
    expect(element.parent).toBeNull();
    expect(element.selfClosing).toBe(true);
    expect(element.children).toHaveLength(3);
    expect(textContent(element)).toBe("a < b & c > d tail\r\n");
  });

  it("escapes attribute values so that they survive a second parse", () => {
    const value = "tab\there \"quoted\" 'single' <&> line\nbreak\rreturn";
    const element = createElement("a", { v: value });
    const text = serializeXml(element);
    expect(text).toBe('<a v="tab&#9;here &quot;quoted&quot; \'single\' &lt;&amp;> line&#10;break&#13;return"/>');
    expect(getAttr(parseXml(text).root, "v")).toBe(value);
  });

  it("exposes the escaping used by the serialiser", () => {
    expect(escapeXmlText("a < b && c > d \"q\" 'r'")).toBe("a &lt; b &amp;&amp; c &gt; d \"q\" 'r'");
    expect(escapeXmlText("plain")).toBe("plain");
    expect(escapeXmlAttr('<a href="x">&\t\n\r\'')).toBe("&lt;a href=&quot;x&quot;>&amp;&#9;&#10;&#13;'");
    expect(escapeXmlAttr("plain")).toBe("plain");
  });

  it("drops characters that XML cannot carry instead of writing a broken file", () => {
    const element = createElement("a", { v: "x\u0000y\u000bz" }, ["one\u0001two￾\u0008"]);
    const text = serializeXml(element);
    expect(text).toBe('<a v="xyz">onetwo</a>');
    expect(textContent(parseXml(text).root)).toBe("onetwo");
  });

  it("keeps a text node that ends a CDATA section readable", () => {
    const doc = parseXml("<a><![CDATA[x]]></a>");
    appendChild(doc.root, createText("]]>"));
    const text = serializeXml(doc);
    expect(text).toBe("<a><![CDATA[x]]>]]&gt;</a>");
    expect(textContent(parseXml(text).root)).toBe("x]]>");
  });

  it("rejects names that would not parse", () => {
    for (const name of ["", "1a", "a b", "a>", "a=\"", "<a", "-a", "a/b"]) {
      expectCode(() => createElement(name), "invalid_argument");
      expectCode(() => setAttr(createElement("ok"), name, "v"), "invalid_argument");
    }
    expectCode(() => createElement("a", [["x", "1"], ["x", "2"]]), "invalid_argument");
  });

  it("moves a child handed to createElement out of its old parent", () => {
    const doc = parseXml("<a><b/><c/></a>");
    const b = child(doc.root, "b") as XmlElement;
    const wrapper = createElement("w", undefined, [b]);
    expect(b.parent).toBe(wrapper);
    expect(serializeXml(doc)).toBe("<a><c/></a>");
    expect(serializeXml(wrapper)).toBe("<w><b/></w>");
  });
});

describe("cloning", () => {
  it("copies a subtree that serialises identically and is independent", () => {
    const doc = parseXml(KITCHEN_SINK);
    const copy = cloneNode(doc.root);
    expect(copy).not.toBe(doc.root);
    expect(copy.parent).toBeNull();
    expect(serializeXml(copy)).toBe(serializeXml(doc.root));
    for (const node of copy.children) expect(node.parent).toBe(copy);

    setAttr(copy, "empty", "changed");
    setText((child(copy, "text") as XmlElement).children[0] as XmlText, "changed");
    expect(serializeXml(doc)).toBe(KITCHEN_SINK);
    expect(getAttr(doc.root, "empty")).toBe("");
  });

  it("clones text, comments and other leaf nodes", () => {
    const doc = parseXml("<a>t&amp;<!--c--><![CDATA[d]]><?p q?></a>");
    const copies = doc.root.children.map((node) => cloneNode(node));
    expect(copies.map((node) => node.parent)).toEqual([null, null, null, null]);
    const holder = createElement("a", undefined, copies);
    expect(serializeXml(holder)).toBe("<a>t&amp;<!--c--><![CDATA[d]]><?p q?></a>");
    expect(serializeXml(doc)).toBe("<a>t&amp;<!--c--><![CDATA[d]]><?p q?></a>");
  });

  it("copies a whole document that serialises identically and is independent", () => {
    for (const source of ["\ufeff" + KITCHEN_SINK, WORD_DOCUMENT, "<a/>"]) {
      const doc = parseXml(source);
      const copy = cloneDocument(doc);
      expect(copy).not.toBe(doc);
      expect(copy.bom).toBe(doc.bom);
      expect(serializeXml(copy)).toBe(source);
      expect(copy.root).not.toBe(doc.root);
      expect(copy.root.parent).toBe(copy);
      expect(copy.children.indexOf(copy.root)).toBe(doc.children.indexOf(doc.root));
      for (const node of copy.children) expect(node.parent).toBe(copy);
      for (const node of copy.children) expect(doc.children).not.toContain(node);

      setAttr(copy.root, "copied", "yes");
      appendChild(copy.root, createElement("extra"));
      expect(serializeXml(doc)).toBe(source);
      expect(serializeXml(copy)).not.toBe(source);
    }
  });

  it("refuses to clone something that is not a document", () => {
    const doc = parseXml("<a/>");
    expectCode(() => cloneDocument(doc.root as never), "invalid_argument");
  });

  it("carries nodes between documents with their original spelling", () => {
    const from = parseXml("<x><y  q = 'a&#38;b'>&#x41;</y></x>");
    const into = parseXml("<z/>");
    appendChild(into.root, child(from.root, "y") as XmlElement);
    expect(serializeXml(into)).toBe("<z><y  q = 'a&#38;b'>&#x41;</y></z>");
    expect(serializeXml(from)).toBe("<x></x>");
  });
});

describe("refused tree edits", () => {
  it("refuses to insert a node into its own subtree", () => {
    const doc = parseXml("<a><b><c/></b></a>");
    const b = child(doc.root, "b") as XmlElement;
    const c = child(b, "c") as XmlElement;
    expectCode(() => appendChild(c, b), "invalid_operation");
    expectCode(() => appendChild(b, b), "invalid_operation");
    expectCode(() => prependChild(c, b), "invalid_operation");
    expectCode(() => insertBefore(c, b), "invalid_operation");
    expectCode(() => insertAfter(c, b), "invalid_operation");
    expectCode(() => replaceNode(c, b), "invalid_operation");
    expect(serializeXml(doc)).toBe("<a><b><c/></b></a>");
    expect(b.parent).toBe(doc.root);
  });

  it("refuses to insert next to a node that has no element parent", () => {
    const doc = parseXml("<a><b/></a>");
    const detached = createElement("d");
    expectCode(() => insertBefore(detached, createElement("e")), "invalid_operation");
    expectCode(() => insertAfter(detached, createElement("e")), "invalid_operation");
    expectCode(() => insertBefore(doc.root, createElement("e")), "invalid_operation");
    expectCode(() => insertAfter(doc.root, createElement("e")), "invalid_operation");
    expectCode(() => replaceNode(detached, createElement("e")), "invalid_operation");
    expectCode(() => replaceNode(doc.root, createElement("e")), "invalid_operation");
  });

  it("refuses to take the document element out of its document", () => {
    const doc = parseXml("<a><b/></a>");
    expectCode(() => remove(doc.root), "invalid_operation");
    expectCode(() => appendChild(createElement("holder"), doc.root), "invalid_operation");
    expect(doc.root.parent).toBe(doc);
    expect(serializeXml(doc)).toBe("<a><b/></a>");
  });

  it("refuses arguments of the wrong kind", () => {
    const doc = parseXml("<?xml version='1.0'?><a>t</a>");
    const text = doc.root.children[0] as XmlText;
    expectCode(() => appendChild(doc as never, createElement("b")), "invalid_argument");
    expectCode(() => appendChild(text as never, createElement("b")), "invalid_argument");
    expectCode(() => prependChild(doc.root, doc.children[0] as never), "invalid_argument");
    expectCode(() => appendChild(doc.root, "text" as never), "invalid_argument");
    expectCode(() => setAttr(doc.root, "a", 1 as never), "invalid_argument");
    expectCode(() => setText(doc.root as never, "x"), "invalid_argument");
    expectCode(() => setText(text, null as never), "invalid_argument");
    expectCode(() => setTextContent(text as never, "x"), "invalid_argument");
    expectCode(() => createText(7 as never), "invalid_argument");
    expectCode(() => cloneNode(doc as never), "invalid_argument");
    expectCode(() => serializeXml(text as never), "invalid_argument");
    expect(serializeXml(doc)).toBe("<?xml version='1.0'?><a>t</a>");
  });

  it("treats inserting a node next to itself as no change", () => {
    const doc = parseXml("<a><b/><c/></a>");
    const b = child(doc.root, "b") as XmlElement;
    insertBefore(b, b);
    insertAfter(b, b);
    replaceNode(b, b);
    expect(serializeXml(doc)).toBe("<a><b/><c/></a>");
  });

  it("removes top-level comments but keeps the tree consistent", () => {
    const doc = parseXml("<!--x--><a/>");
    const comment = doc.children[0];
    if (comment?.kind !== "comment") throw new Error("expected a comment");
    remove(comment);
    expect(comment.parent).toBeNull();
    expect(serializeXml(doc)).toBe("<a/>");
  });
});
