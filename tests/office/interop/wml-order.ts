/**
 * WordprocessingML structure rules, checked on the raw XML: the child order
 * the schema gives `w:pPr`, `w:rPr`, `w:tcPr`, `w:tblPr`, `w:trPr`,
 * `w:sectPr`, settings, styles and numbering; where revision elements may
 * stand and what they may hold; deleted text in `w:delText`; `xml:space` on
 * padded text.
 *
 * The rules come from the transitional schema (ECMA-376 Part 1) and from
 * what word processors require beyond it.
 */

import type { XmlElement } from "../../../packages/office/src/index.js";
import { attr, elementsOf, hasAncestor, orderProblems, parentElement, sourceText, text, walk, where } from "./package.js";

const names = (list: string): string[] => list.split(/\s+/).filter((name) => name !== "").map((name) => `w:${name}`);

const RPR_BASE = names(
  "rStyle rFonts b bCs i iCs caps smallCaps strike dstrike outline shadow emboss imprint noProof snapToGrid vanish webHidden color spacing w kern position sz szCs highlight u effect bdr shd fitText vertAlign rtl cs em lang eastAsianLayout specVanish oMath",
);
const PPR_BASE = names(
  "pStyle keepNext keepLines pageBreakBefore framePr widowControl numPr suppressLineNumbers pBdr shd tabs suppressAutoHyphens kinsoku wordWrap overflowPunct topLinePunct autoSpaceDE autoSpaceDN bidi adjustRightInd snapToGrid spacing ind contextualSpacing mirrorIndents suppressOverlap jc textDirection textAlignment textboxTightWrap outlineLvl divId cnfStyle",
);
const TCPR_BASE = names("cnfStyle tcW gridSpan hMerge vMerge tcBorders shd noWrap tcMar textDirection tcFitText vAlign hideMark headers");
const TBLPR_BASE = names(
  "tblStyle tblpPr tblOverlap bidiVisual tblStyleRowBandSize tblStyleColBandSize tblW jc tblCellSpacing tblInd tblBorders shd tblLayout tblCellMar tblLook tblCaption tblDescription",
);
const TRPR_CHOICE = new Set(names("cnfStyle divId gridBefore gridAfter wBefore wAfter cantSplit trHeight tblHeader tblCellSpacing jc hidden"));
const SECTPR_BASE = names(
  "footnotePr endnotePr type pgSz pgMar paperSrc pgBorders lnNumType pgNumType cols formProt vAlign noEndnote titlePg textDirection bidi rtlGutter docGrid printerSettings",
);
const SETTINGS = [
  ...names(
    "writeProtection view zoom removePersonalInformation removeDateAndTime doNotDisplayPageBoundaries displayBackgroundShape printPostScriptOverText printFractionalCharacterWidth printFormsData embedTrueTypeFonts embedSystemFonts saveSubsetFonts saveFormsData mirrorMargins alignBordersAndEdges bordersDoNotSurroundHeader bordersDoNotSurroundFooter gutterAtTop hideSpellingErrors hideGrammaticalErrors activeWritingStyle proofState formsDesign attachedTemplate linkStyles stylePaneFormatFilter stylePaneSortMethod documentType mailMerge revisionView trackRevisions doNotTrackMoves doNotTrackFormatting documentProtection autoFormatOverride styleLockTheme styleLockQFSet defaultTabStop autoHyphenation consecutiveHyphenLimit hyphenationZone doNotHyphenateCaps showEnvelope summaryLength clickAndTypeStyle defaultTableStyle evenAndOddHeaders bookFoldRevPrinting bookFoldPrinting bookFoldPrintingSheets drawingGridHorizontalSpacing drawingGridVerticalSpacing displayHorizontalDrawingGridEvery displayVerticalDrawingGridEvery doNotUseMarginsForDrawingGridOrigin drawingGridHorizontalOrigin drawingGridVerticalOrigin doNotShadeFormData noPunctuationKerning characterSpacingControl printTwoOnOne strictFirstAndLastChars noLineBreaksAfter noLineBreaksBefore savePreviewPicture doNotValidateAgainstSchema saveInvalidXml ignoreMixedContent alwaysShowPlaceholderText doNotDemarcateInvalidXml saveXmlDataOnly useXSLTWhenSaving saveThroughXslt showXMLTags alwaysMergeEmptyNamespace updateFields hdrShapeDefaults footnotePr endnotePr compat docVars rsids",
  ),
  "m:mathPr",
  ...names(
    "attachedSchema themeFontLang clrSchemeMapping doNotIncludeSubdocsInStats doNotAutoCompressPictures forceUpgrade captions readModeInkLockDown smartTagType schemaLibrary shapeDefaults doNotEmbedSmartTags decimalSymbol listSeparator",
  ),
];
const STYLE = names(
  "name aliases basedOn next link autoRedefine hidden uiPriority semiHidden unhideWhenUsed qFormat locked personal personalCompose personalReply rsid pPr rPr tblPr trPr tcPr tblStylePr",
);
const LVL = names("start numFmt lvlRestart pStyle isLgl suff lvlText lvlPicBulletId legacy lvlJc pPr rPr");
const ABSTRACT_NUM = names("nsid multiLevelType tmpl name styleLink numStyleLink lvl");
const REPEATABLE = new Set(
  names("headerReference footerReference lvl lvlOverride abstractNum num style tblStylePr numPicBullet smartTagType attachedSchema activeWritingStyle"),
);

const RUN_CONTENT = new Set(
  names(
    "rPr br t contentPart delText instrText delInstrText noBreakHyphen softHyphen dayShort monthShort yearShort dayLong monthLong yearLong annotationRef footnoteRef endnoteRef separator continuationSeparator sym pgNum cr tab object pict fldChar ruby footnoteReference endnoteReference commentReference drawing ptab lastRenderedPageBreak",
  ),
);
const RANGE_MARKUP = names(
  "bookmarkStart bookmarkEnd moveFromRangeStart moveFromRangeEnd moveToRangeStart moveToRangeEnd commentRangeStart commentRangeEnd customXmlInsRangeStart customXmlInsRangeEnd customXmlDelRangeStart customXmlDelRangeEnd customXmlMoveFromRangeStart customXmlMoveFromRangeEnd customXmlMoveToRangeStart customXmlMoveToRangeEnd",
);
const RUN_LEVEL = [...names("proofErr permStart permEnd ins del moveFrom moveTo"), ...RANGE_MARKUP];
const CONTENT_RUN = new Set([...names("customXml smartTag sdt dir bdo r"), ...RUN_LEVEL]);
const PARAGRAPH_CONTENT = new Set([...CONTENT_RUN, ...names("fldSimple hyperlink subDoc pPr")]);
const BLOCK_LEVEL = new Set([...names("customXml sdt p tbl altChunk"), ...RUN_LEVEL]);
export const TRACK = new Set(names("ins del moveFrom moveTo"));
export const PROPERTY_CHANGES = new Set(
  names("rPrChange pPrChange sectPrChange tblPrChange trPrChange tcPrChange tblGridChange tblPrExChange numberingChange cellIns cellDel cellMerge"),
);
const CHANGE_HOLDS: Record<string, [parent: string, inner: string | null]> = {
  "w:rPrChange": ["w:rPr", "w:rPr"],
  "w:pPrChange": ["w:pPr", "w:pPr"],
  "w:sectPrChange": ["w:sectPr", "w:sectPr"],
  "w:tblPrChange": ["w:tblPr", "w:tblPr"],
  "w:trPrChange": ["w:trPr", "w:trPr"],
  "w:tcPrChange": ["w:tcPr", "w:tcPr"],
  "w:tblGridChange": ["w:tblGrid", null],
  "w:tblPrExChange": ["w:tblPrEx", "w:tblPrEx"],
  "w:numberingChange": ["w:numPr", null],
  "w:cellIns": ["w:tcPr", null],
  "w:cellDel": ["w:tcPr", null],
  "w:cellMerge": ["w:tcPr", null],
};
const TRACK_PARENTS = new Set([
  ...names("p hyperlink fldSimple smartTag sdtContent customXml dir bdo body tc tbl tr hdr ftr footnote endnote comment txbxContent docPartBody"),
  ...TRACK,
]);
const RUN_PARENTS = new Set(names("p hyperlink fldSimple ins del moveFrom moveTo smartTag sdtContent customXml dir bdo rt rubyBase"));
const DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/;

function orderFor(element: XmlElement, parent: string): [order: string[], what: string] | null {
  switch (element.name) {
    case "w:rPr":
      if (parent === "w:pPr") return [[...names("ins del moveFrom moveTo"), ...RPR_BASE, "w:rPrChange"], "w:rPr of a paragraph mark"];
      if (parent === "w:rPrChange") return [RPR_BASE, "w:rPr in w:rPrChange"];
      return [[...RPR_BASE, "w:rPrChange"], "w:rPr"];
    case "w:pPr":
      if (parent === "w:p") return [[...PPR_BASE, ...names("rPr sectPr pPrChange")], "w:pPr"];
      if (parent === "w:pPrChange") return [PPR_BASE, "w:pPr in w:pPrChange"];
      return [[...PPR_BASE, "w:pPrChange"], "w:pPr of a style"];
    case "w:tcPr":
      return [[...TCPR_BASE, ...names("cellIns cellDel cellMerge"), ...(parent === "w:tcPrChange" ? [] : ["w:tcPrChange"])], "w:tcPr"];
    case "w:tblPr":
      return [parent === "w:tblPrChange" ? TBLPR_BASE : [...TBLPR_BASE, "w:tblPrChange"], "w:tblPr"];
    case "w:sectPr":
      if (parent === "w:sectPrChange") return [SECTPR_BASE, "w:sectPr in w:sectPrChange"];
      return [[...names("headerReference footerReference"), ...SECTPR_BASE, "w:sectPrChange"], "w:sectPr"];
    case "w:tblPrEx":
      return [names("tblW jc tblCellSpacing tblInd tblBorders shd tblLayout tblCellMar tblLook tblPrExChange"), "w:tblPrEx"];
    case "w:numPr":
      return [names("ilvl numId numberingChange ins"), "w:numPr"];
    case "w:settings":
      return [SETTINGS, "w:settings"];
    case "w:style":
      return [STYLE, "w:style"];
    case "w:lvl":
      return [LVL, "w:lvl"];
    case "w:abstractNum":
      return [ABSTRACT_NUM, "w:abstractNum"];
    case "w:num":
      return [names("abstractNumId lvlOverride"), "w:num"];
    case "w:numbering":
      return [names("numPicBullet abstractNum num numIdMacAtCleanup"), "w:numbering"];
    case "w:styles":
      return [names("docDefaults latentStyles style"), "w:styles"];
    default:
      return null;
  }
}

/** `first` must come before every other `w:` child, in that order (`w:pPr` in a paragraph, `w:rPr` in a run). */
function leadingProblems(element: XmlElement, first: readonly string[]): string[] {
  const problems: string[] = [];
  let stage = 0;
  let content = false;
  for (const child of elementsOf(element)) {
    const index = first.indexOf(child.name);
    if (index === -1) {
      if (!(element.name === "w:tbl" && RANGE_MARKUP.includes(child.name))) content = true;
      continue;
    }
    if (content) problems.push(`<${child.name}> must come before the content of <${element.name}> (${where(element)})`);
    else if (index < stage) problems.push(`<${child.name}> is out of order or repeated in <${element.name}>`);
    stage = index + 1;
  }
  return problems;
}

function trPrProblems(element: XmlElement): string[] {
  const problems: string[] = [];
  const tail: Record<string, number> = { "w:ins": 1, "w:del": 2, "w:trPrChange": 3 };
  let stage = 0;
  for (const child of elementsOf(element)) {
    if (!child.name.startsWith("w:")) continue;
    const rank = tail[child.name];
    if (TRPR_CHOICE.has(child.name)) {
      if (stage > 0) problems.push(`<${child.name}> comes after a revision element in <w:trPr>`);
    } else if (rank !== undefined) {
      if (rank <= stage) problems.push(`<${child.name}> is out of order or repeated in <w:trPr>`);
      stage = rank;
      if (child.name !== "w:trPrChange" && elementsOf(child).length > 0) problems.push(`<${child.name}> in <w:trPr> must be empty`);
    } else {
      problems.push(`<${child.name}> is not allowed in <w:trPr>`);
    }
  }
  return problems;
}

/** `w:id`, `w:author` and `w:date` of a revision element. */
function attributeProblems(element: XmlElement): string[] {
  const problems: string[] = [];
  const id = attr(element, "w:id");
  if (id === null) problems.push(`<${element.name}> has no w:id`);
  else if (!/^-?\d+$/.test(id)) problems.push(`<${element.name}> has the non-numeric w:id ${JSON.stringify(id)}`);
  if (element.name === "w:cellMerge") return problems;
  const author = attr(element, "w:author");
  if (author === null || author === "") problems.push(`<${element.name}> has no w:author`);
  const date = attr(element, "w:date");
  if (date === null) problems.push(`<${element.name}> has no w:date`);
  else if (!DATE.test(date)) problems.push(`<${element.name}> has the malformed w:date ${JSON.stringify(date)}`);
  return problems;
}

function trackProblems(element: XmlElement, parent: string): string[] {
  const problems = attributeProblems(element);
  const children = elementsOf(element);
  if (parent === "w:rPr" || parent === "w:trPr" || parent === "w:numPr") {
    const mark = parentElement(element);
    if (parent === "w:rPr" && (mark === null || parentElement(mark)?.name !== "w:pPr")) {
      problems.push(`<${element.name}> in the <w:rPr> of a run (only a paragraph mark may carry it)`);
    }
    if (children.length > 0) problems.push(`<${element.name}> in <${parent}> must be empty`);
    return problems;
  }
  if (!TRACK_PARENTS.has(parent)) problems.push(`<${element.name}> is not allowed in <${parent}> (${where(element)})`);
  for (const child of children) {
    if (child.name.startsWith("w:") && !CONTENT_RUN.has(child.name)) {
      problems.push(`<${child.name}> is not allowed inside <${element.name}>: a revision wraps runs, not links, fields or paragraphs`);
    }
  }
  if (children.length === 0) problems.push(`empty <${element.name}> (${where(element)})`);
  if ((element.name === "w:ins" || element.name === "w:moveTo") && (parent === "w:del" || parent === "w:moveFrom")) {
    problems.push(`<${element.name}> nested inside <${parent}>`);
  }
  if (element.name === parent) problems.push(`<${element.name}> nested directly inside <${element.name}>`);
  return problems;
}

function textProblems(element: XmlElement): string[] {
  const problems: string[] = [];
  const value = text(element);
  const shown = JSON.stringify(value.slice(0, 30));
  if (value !== value.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, "") && attr(element, "xml:space") !== "preserve") {
    problems.push(`<${element.name}> text ${shown} has leading or trailing white space without xml:space="preserve"`);
  }
  if ((element.name === "w:t" || element.name === "w:delText") && /[\t\r\n]/.test(sourceText(element))) {
    problems.push(`<${element.name}> holds a raw tab or line break ${shown}`);
  }
  const deleted = hasAncestor(element, new Set(["w:del"]));
  if ((element.name === "w:t" || element.name === "w:instrText") && deleted) {
    problems.push(`<${element.name}> inside <w:del>: deleted text must be <w:del${element.name.slice(2, 3).toUpperCase()}${element.name.slice(3)}> ${shown}`);
  }
  if ((element.name === "w:delText" || element.name === "w:delInstrText") && !deleted) problems.push(`<${element.name}> outside <w:del> ${shown}`);
  if (elementsOf(element).length > 0) problems.push(`<${element.name}> has child elements`);
  return problems;
}

/** Structure problems of one part (`w:document`, a header, the styles, the settings, ...). */
export function structureProblems(root: XmlElement): string[] {
  const problems: string[] = [];
  for (const element of walk(root)) {
    if (!element.name.startsWith("w:")) continue;
    const parent = parentElement(element)?.name ?? "";
    const spec = orderFor(element, parent);
    if (spec !== null) problems.push(...orderProblems(element, spec[0], spec[1], "w:", REPEATABLE));
    const children = elementsOf(element);
    const wChildren = children.filter((child) => child.name.startsWith("w:"));
    switch (element.name) {
      case "w:trPr":
        if (parent !== "w:trPrChange") problems.push(...trPrProblems(element));
        break;
      case "w:p":
        problems.push(...leadingProblems(element, ["w:pPr"]));
        for (const child of wChildren) if (!PARAGRAPH_CONTENT.has(child.name)) problems.push(`<${child.name}> is not allowed in <w:p>`);
        break;
      case "w:r":
        problems.push(...leadingProblems(element, ["w:rPr"]));
        for (const child of wChildren) if (!RUN_CONTENT.has(child.name)) problems.push(`<${child.name}> is not allowed in <w:r>`);
        if (parent.startsWith("w:") && !RUN_PARENTS.has(parent)) {
          problems.push(`<w:r> is not allowed in <${parent}> (${where(element)})`);
        }
        break;
      case "w:tbl": {
        problems.push(...leadingProblems(element, ["w:tblPr", "w:tblGrid"]));
        const kids = wChildren.map((child) => child.name);
        if (!kids.includes("w:tblPr") || !kids.includes("w:tblGrid")) problems.push("a table lacks <w:tblPr> or <w:tblGrid>");
        if (!kids.includes("w:tr")) problems.push("a table has no rows");
        break;
      }
      case "w:tr":
        problems.push(...leadingProblems(element, ["w:tblPrEx", "w:trPr"]));
        if (!wChildren.some((child) => child.name === "w:tc" || child.name === "w:sdt" || child.name === "w:customXml")) problems.push("a table row has no cells");
        break;
      case "w:tc": {
        problems.push(...leadingProblems(element, ["w:tcPr"]));
        const blocks = wChildren.filter((child) => child.name !== "w:tcPr");
        const last = blocks[blocks.length - 1];
        if (last === undefined) problems.push("a table cell has no content");
        else if (last.name !== "w:p") problems.push(`a table cell does not end with a paragraph (ends with <${last.name}>)`);
        for (const child of blocks) if (!BLOCK_LEVEL.has(child.name)) problems.push(`<${child.name}> is not allowed in <w:tc>`);
        break;
      }
      case "w:body":
        wChildren.forEach((child, index) => {
          if (child.name === "w:sectPr") {
            if (index !== wChildren.length - 1) problems.push("<w:sectPr> is not the last child of <w:body>");
          } else if (!BLOCK_LEVEL.has(child.name)) problems.push(`<${child.name}> is not allowed in <w:body>`);
        });
        break;
      case "w:hyperlink":
      case "w:fldSimple":
        if (TRACK.has(parent)) problems.push(`<${element.name}> is not allowed inside <${parent}>: a revision wraps runs, not links or fields`);
        for (const child of wChildren) {
          if (child.name !== "w:fldData" && (child.name === "w:pPr" || !PARAGRAPH_CONTENT.has(child.name))) problems.push(`<${child.name}> is not allowed in <${element.name}>`);
        }
        break;
      case "w:t":
      case "w:delText":
      case "w:instrText":
      case "w:delInstrText":
        problems.push(...textProblems(element));
        break;
      default:
        if (TRACK.has(element.name)) problems.push(...trackProblems(element, parent));
        else if (PROPERTY_CHANGES.has(element.name)) {
          problems.push(...attributeProblems(element));
          const [holder, inner] = CHANGE_HOLDS[element.name] as [string, string | null];
          if (parent !== holder) problems.push(`<${element.name}> is in <${parent}>, expected <${holder}>`);
          const kids = wChildren.map((child) => child.name);
          if (inner !== null && !(kids.length === 1 && kids[0] === inner) && !(element.name === "w:sectPrChange" && kids.length === 0)) {
            problems.push(`<${element.name}> must hold exactly one <${inner}>, holds [${kids.join(", ")}]`);
          }
          if (hasAncestor(element, new Set([element.name]))) problems.push(`<${element.name}> is nested in another <${element.name}>`);
        }
    }
  }
  return problems;
}
