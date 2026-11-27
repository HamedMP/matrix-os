/**
 * Reads the blocks of a story container into the tree the comparison aligns:
 * paragraphs with their comparison text, tables with their rows and cells.
 */

import type { PartName } from "../../api/opc.js";
import type { XmlChildNode, XmlElement } from "../../api/xml.js";
import { type DocxIndex, type InlineAtom, OBJECT_CHAR, attr, rowCells, tableRows } from "../internal.js";
import { type MediaTable, mediaKey } from "./media.js";
import type { BlockNode, CellNode, ParaNode, RowNode, TableNode } from "./types.js";

/** Stands for a paragraph mark where the texts of several paragraphs are compared as one. */
export const PARAGRAPH_MARK = "";
/** Starts the alignment key of a table, so a table never pairs with a paragraph of the same text. */
export const TABLE_KEY = "";

const FIRST_OBJECT = 0xe000;
const LAST_OBJECT = 0xf8fd;
const PICTURES: ReadonlySet<string> = new Set(["w:drawing", "w:pict", "w:object", "mc:AlternateContent"]);
const MATH: ReadonlySet<string> = new Set(["m:oMath", "m:oMathPara"]);
/** Nodes of one equation read for its signature; past this, two equations that agree so far count as equal. */
const MAX_SIGNATURE_NODES = 2000;

/**
 * One character per kind of inline object, shared by both documents: two
 * objects compare equal when they are the same kind of thing (and, for
 * pictures, the same image at the same size; for symbols, the same character
 * in the same font; for equations, the same content).
 */
export class ObjectAlphabet {
  private readonly characters = new Map<string, string>();

  characterFor(signature: string): string {
    let character = this.characters.get(signature);
    if (character === undefined) {
      const code = FIRST_OBJECT + this.characters.size;
      character = code <= LAST_OBJECT ? String.fromCharCode(code) : OBJECT_CHAR;
      this.characters.set(signature, character);
    }
    return character;
  }
}

export interface ExtractContext {
  readonly index: DocxIndex;
  readonly media: MediaTable;
  readonly alphabet: ObjectAlphabet;
  /** The part the container belongs to. */
  readonly partName: PartName;
}

function pictureSignature(node: XmlElement, context: ExtractContext): string {
  const parts: string[] = [];
  const stack: XmlElement[] = [node];
  for (let visited = 0; stack.length > 0 && visited < 2000; visited++) {
    const element = stack.pop() as XmlElement;
    if (element.name === "wp:extent") parts.push(`${attr(element, "cx") ?? ""}x${attr(element, "cy") ?? ""}`);
    for (const entry of element.attrs) {
      if (!entry.name.startsWith("r:")) continue;
      parts.push(context.media.get(mediaKey(context.partName, entry.value))?.signature ?? "linked");
    }
    for (const child of element.children) if (child.kind === "element") stack.push(child);
  }
  return parts.sort().join(",");
}

/**
 * The content of an equation: its elements, attributes and text in document
 * order, so an edited equation compares unequal. Namespace declarations are
 * left out, since they do not change what the equation says.
 */
function contentSignature(node: XmlElement): string {
  const parts: string[] = [];
  const stack: XmlChildNode[] = [node];
  for (let visited = 0; stack.length > 0 && visited < MAX_SIGNATURE_NODES; visited++) {
    const current = stack.pop() as XmlChildNode;
    if (current.kind === "text" || current.kind === "cdata") {
      parts.push(JSON.stringify(current.value));
      continue;
    }
    if (current.kind !== "element") continue;
    let open = `<${current.name}`;
    for (const entry of current.attrs) {
      if (entry.name !== "xmlns" && !entry.name.startsWith("xmlns:")) open += ` ${entry.name}=${JSON.stringify(entry.value)}`;
    }
    parts.push(`${open}>`);
    for (let index = current.children.length - 1; index >= 0; index--) stack.push(current.children[index] as XmlChildNode);
  }
  return parts.join("");
}

function objectSignature(atom: InlineAtom, context: ExtractContext): string {
  const node = atom.node;
  if (node.name === "w:br") return `w:br:${attr(node, "w:type") ?? ""}`;
  if (node.name === "w:sym") return `w:sym:${attr(node, "w:font") ?? ""}:${(attr(node, "w:char") ?? "").toUpperCase()}`;
  if (MATH.has(node.name)) return `${node.name}:${contentSignature(node)}`;
  if (PICTURES.has(node.name)) return `${node.name}:${pictureSignature(node, context)}`;
  return node.name;
}

function comparisonText(atoms: readonly InlineAtom[], context: ExtractContext): string {
  let text = "";
  for (const atom of atoms) {
    text += atom.kind === "object" ? context.alphabet.characterFor(objectSignature(atom, context)) : atom.text;
  }
  return text;
}

/** The blocks of a story container or table cell, in order. */
export function extractBlocks(context: ExtractContext, container: XmlElement): BlockNode[] {
  const records = context.index.blocksIn(container);
  const blocks: BlockNode[] = [];
  for (let position = 0; position < records.length; position++) {
    const record = records[position];
    if (record === undefined || record.type === "sectionBreak") continue;
    if (record.type === "paragraph") {
      const scan = context.index.scan(record.element);
      const paragraph: ParaNode = {
        kind: "paragraph",
        element: record.element,
        fieldsIn: scan.fieldsIn,
        text: comparisonText(scan.atoms, context),
        endsSection: records[position + 1]?.type === "sectionBreak",
      };
      blocks.push(paragraph);
      continue;
    }
    const rows: RowNode[] = [];
    for (const rowElement of tableRows(record.element)) {
      const cells: CellNode[] = rowCells(rowElement).map((cell) => ({ element: cell, blocks: extractBlocks(context, cell) }));
      rows.push({
        element: rowElement,
        cells,
        text: cells.map((cell) => cell.blocks.map((block) => block.text).join("\n")).join("\t"),
      });
    }
    const table: TableNode = { kind: "table", element: record.element, rows, text: rows.map((row) => row.text).join("\n") };
    blocks.push(table);
  }
  return blocks;
}

/** The key a block is aligned by. */
export function blockKey(block: BlockNode): string {
  return block.kind === "paragraph" ? block.text : `${TABLE_KEY}${block.text}`;
}
