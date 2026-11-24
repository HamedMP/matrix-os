/**
 * Writes the blocks of a new document as `word/document.xml`: an A4 portrait
 * section with 1 inch margins.
 */

import { escapeXmlAttr, escapeXmlText } from "../../xml/index.js";
import type { NewBlock, NewParagraphBlock, NewRun, NewTableBlock } from "./model.js";

const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

/** A4 in twips, and the text width between 1440-twip margins. */
const PAGE_WIDTH = 11906;
const PAGE_HEIGHT = 16838;
const MARGIN = 1440;
export const TEXT_WIDTH = PAGE_WIDTH - 2 * MARGIN;

const SECTION =
  `<w:sectPr><w:pgSz w:w="${PAGE_WIDTH}" w:h="${PAGE_HEIGHT}"/>` +
  `<w:pgMar w:top="${MARGIN}" w:right="${MARGIN}" w:bottom="${MARGIN}" w:left="${MARGIN}" ` +
  'w:header="708" w:footer="708" w:gutter="0"/><w:cols w:space="708"/><w:docGrid w:linePitch="360"/></w:sectPr>';

const SAFE_LINK = /^(?:https?:\/\/|mailto:)[^\s<>"]+$/i;

/** True for an external link target the importer writes as a hyperlink. */
export function isSafeLinkTarget(href: string): boolean {
  return SAFE_LINK.test(href) && href.length <= 2048;
}

/** Gives the relationship id of an external hyperlink, adding it on first use. */
export type LinkRelationship = (href: string) => string;

const twips = (points: number): number => Math.round(points * 20);

function runXml(run: NewRun, extraBold: boolean): string {
  let properties = "";
  if (run.code === true) properties += '<w:rStyle w:val="InlineCode"/>';
  else if (run.href !== undefined) properties += '<w:rStyle w:val="Hyperlink"/>';
  if (run.bold === true || extraBold) properties += "<w:b/><w:bCs/>";
  if (run.italic === true) properties += "<w:i/><w:iCs/>";
  if (run.strike === true) properties += "<w:strike/>";
  let content = "";
  let text = "";
  const flush = (): void => {
    if (text === "") return;
    const preserve = /^\s|\s$|\s\s/.test(text) ? ' xml:space="preserve"' : "";
    content += `<w:t${preserve}>${escapeXmlText(text)}</w:t>`;
    text = "";
  };
  for (const char of run.text) {
    if (char === "\t" || char === "\n") {
      flush();
      content += char === "\t" ? "<w:tab/>" : "<w:br/>";
    } else {
      text += char;
    }
  }
  flush();
  return `<w:r>${properties === "" ? "" : `<w:rPr>${properties}</w:rPr>`}${content}</w:r>`;
}

function runsXml(runs: readonly NewRun[], link: LinkRelationship, bold = false): string {
  let xml = "";
  for (let index = 0; index < runs.length; index++) {
    const run = runs[index] as NewRun;
    if (run.text === "") continue;
    if (run.href === undefined || !isSafeLinkTarget(run.href)) {
      xml += runXml(run.href === undefined ? run : { ...run, href: undefined }, bold);
      continue;
    }
    // Neighbouring runs with the same target share one hyperlink element.
    const href = run.href;
    let inner = "";
    while (index < runs.length && (runs[index] as NewRun).href === href) {
      inner += runXml(runs[index] as NewRun, bold);
      index++;
    }
    index--;
    xml += `<w:hyperlink r:id="${escapeXmlAttr(link(href))}" w:history="1">${inner}</w:hyperlink>`;
  }
  return xml;
}

function paragraphProperties(block: NewParagraphBlock): string {
  let xml = "";
  if (block.styleId !== undefined) xml += `<w:pStyle w:val="${escapeXmlAttr(block.styleId)}"/>`;
  if (block.list !== undefined) {
    xml += `<w:numPr><w:ilvl w:val="${block.list.level}"/><w:numId w:val="${block.list.numId}"/></w:numPr>`;
  }
  if (block.spacingBeforePt !== undefined || block.spacingAfterPt !== undefined) {
    const before = block.spacingBeforePt === undefined ? "" : ` w:before="${twips(block.spacingBeforePt)}"`;
    const after = block.spacingAfterPt === undefined ? "" : ` w:after="${twips(block.spacingAfterPt)}"`;
    xml += `<w:spacing${before}${after}/>`;
  }
  if (block.indentLeftPt !== undefined || block.indentRightPt !== undefined || block.firstLineIndentPt !== undefined) {
    let attrs = "";
    if (block.indentLeftPt !== undefined) attrs += ` w:left="${twips(block.indentLeftPt)}"`;
    if (block.indentRightPt !== undefined) attrs += ` w:right="${twips(block.indentRightPt)}"`;
    if (block.firstLineIndentPt !== undefined) {
      const value = twips(block.firstLineIndentPt);
      attrs += value < 0 ? ` w:hanging="${-value}"` : ` w:firstLine="${value}"`;
    }
    xml += `<w:ind${attrs}/>`;
  }
  if (block.alignment !== undefined) {
    xml += `<w:jc w:val="${block.alignment === "justify" ? "both" : block.alignment}"/>`;
  }
  return xml === "" ? "" : `<w:pPr>${xml}</w:pPr>`;
}

function paragraphXml(block: NewParagraphBlock, link: LinkRelationship, bold = false): string {
  return `<w:p>${paragraphProperties(block)}${runsXml(block.runs, link, bold)}</w:p>`;
}

function tableXml(table: NewTableBlock, link: LinkRelationship): string {
  const columns = Math.max(1, ...table.rows.map((row) => row.length));
  const width = Math.floor(TEXT_WIDTH / columns);
  let xml =
    '<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="5000" w:type="pct"/>' +
    '<w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="1" w:lastColumn="0" ' +
    'w:noHBand="0" w:noVBand="1"/></w:tblPr><w:tblGrid>';
  for (let column = 0; column < columns; column++) xml += `<w:gridCol w:w="${width}"/>`;
  xml += "</w:tblGrid>";
  table.rows.forEach((row, rowIndex) => {
    const header = table.header && rowIndex === 0;
    xml += `<w:tr>${header ? "<w:trPr><w:tblHeader/></w:trPr>" : ""}`;
    for (let column = 0; column < columns; column++) {
      const alignment = table.alignments[column] ?? undefined;
      const paragraph: NewParagraphBlock = { type: "paragraph", runs: row[column] ?? [] };
      if (alignment !== undefined) paragraph.alignment = alignment;
      xml += `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/></w:tcPr>${paragraphXml(paragraph, link, header)}</w:tc>`;
    }
    xml += "</w:tr>";
  });
  return `${xml}</w:tbl>`;
}

/** The text of `word/document.xml`. An empty list gives one empty paragraph. */
export function documentXml(blocks: readonly NewBlock[], link: LinkRelationship): string {
  let body = "";
  for (const block of blocks) body += block.type === "table" ? tableXml(block, link) : paragraphXml(block, link);
  const last = blocks[blocks.length - 1];
  // A body must not be empty, and editors expect a paragraph after a final table.
  if (last === undefined || last.type === "table") body += "<w:p/>";
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    `<w:document xmlns:w="${W_NS}" xmlns:r="${R_NS}"><w:body>${body}${SECTION}</w:body></w:document>`
  );
}
