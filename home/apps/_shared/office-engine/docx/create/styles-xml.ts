/**
 * The styles part of a new document: Normal, Heading 1 to 9, Title,
 * Subtitle, Quote, List Paragraph, Code Block, the Inline Code and Hyperlink
 * character styles, and the Table Grid table style. Element order follows the
 * WordprocessingML schema.
 */

const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const BODY_FONT = "Calibri";
const HEADING_FONT = "Calibri Light";
const CODE_FONT = "Consolas";
const HEADING_COLOR = "1F3864";

interface HeadingLook {
  /** Half-points. */
  size: number;
  bold: boolean;
  italic: boolean;
  /** Twips. */
  before: number;
}

const HEADINGS: readonly HeadingLook[] = [
  { size: 32, bold: true, italic: false, before: 360 },
  { size: 28, bold: true, italic: false, before: 280 },
  { size: 24, bold: true, italic: false, before: 240 },
  { size: 22, bold: true, italic: true, before: 200 },
  { size: 22, bold: true, italic: false, before: 200 },
  { size: 22, bold: false, italic: true, before: 200 },
  { size: 22, bold: false, italic: false, before: 160 },
  { size: 21, bold: false, italic: true, before: 160 },
  { size: 21, bold: false, italic: false, before: 160 },
];

const fonts = (name: string): string => `<w:rFonts w:ascii="${name}" w:hAnsi="${name}" w:eastAsia="${name}" w:cs="${name}"/>`;

function headingStyle(level: number, look: HeadingLook): string {
  const rPr =
    fonts(HEADING_FONT) +
    (look.bold ? "<w:b/><w:bCs/>" : "") +
    (look.italic ? "<w:i/><w:iCs/>" : "") +
    `<w:color w:val="${HEADING_COLOR}"/><w:sz w:val="${look.size}"/><w:szCs w:val="${look.size}"/>`;
  return (
    `<w:style w:type="paragraph" w:styleId="Heading${level}">` +
    `<w:name w:val="heading ${level}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/>` +
    `<w:uiPriority w:val="9"/>${level > 1 ? "<w:unhideWhenUsed/>" : ""}<w:qFormat/>` +
    `<w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="${look.before}" w:after="80"/>` +
    `<w:outlineLvl w:val="${level - 1}"/></w:pPr><w:rPr>${rPr}</w:rPr></w:style>`
  );
}

const DOC_DEFAULTS =
  "<w:docDefaults><w:rPrDefault><w:rPr>" +
  fonts(BODY_FONT) +
  '<w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-GB" w:eastAsia="en-US" w:bidi="ar-SA"/>' +
  "</w:rPr></w:rPrDefault><w:pPrDefault><w:pPr>" +
  '<w:spacing w:after="160" w:line="276" w:lineRule="auto"/>' +
  "</w:pPr></w:pPrDefault></w:docDefaults>";

const BASE_STYLES =
  '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>' +
  '<w:style w:type="character" w:default="1" w:styleId="DefaultParagraphFont">' +
  '<w:name w:val="Default Paragraph Font"/><w:uiPriority w:val="1"/><w:semiHidden/><w:unhideWhenUsed/></w:style>' +
  '<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/>' +
  '<w:uiPriority w:val="99"/><w:semiHidden/><w:unhideWhenUsed/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/>' +
  '<w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/>' +
  '<w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>' +
  '<w:style w:type="numbering" w:default="1" w:styleId="NoList"><w:name w:val="No List"/>' +
  '<w:uiPriority w:val="99"/><w:semiHidden/><w:unhideWhenUsed/></w:style>';

const TITLE_STYLES =
  '<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/>' +
  '<w:next w:val="Normal"/><w:uiPriority w:val="10"/><w:qFormat/>' +
  '<w:pPr><w:spacing w:after="120" w:line="240" w:lineRule="auto"/><w:contextualSpacing/></w:pPr>' +
  `<w:rPr>${fonts(HEADING_FONT)}<w:color w:val="${HEADING_COLOR}"/><w:kern w:val="28"/>` +
  '<w:sz w:val="52"/><w:szCs w:val="52"/></w:rPr></w:style>' +
  '<w:style w:type="paragraph" w:styleId="Subtitle"><w:name w:val="Subtitle"/><w:basedOn w:val="Normal"/>' +
  '<w:next w:val="Normal"/><w:uiPriority w:val="11"/><w:qFormat/><w:pPr><w:spacing w:after="240"/></w:pPr>' +
  '<w:rPr><w:color w:val="595959"/><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr></w:style>';

const BODY_STYLES =
  '<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/>' +
  '<w:next w:val="Normal"/><w:uiPriority w:val="29"/><w:qFormat/>' +
  '<w:pPr><w:spacing w:before="120"/><w:ind w:left="720" w:right="720"/></w:pPr>' +
  '<w:rPr><w:i/><w:iCs/><w:color w:val="404040"/></w:rPr></w:style>' +
  '<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/>' +
  '<w:basedOn w:val="Normal"/><w:uiPriority w:val="34"/><w:qFormat/>' +
  '<w:pPr><w:spacing w:after="80"/><w:ind w:left="720"/><w:contextualSpacing/></w:pPr></w:style>' +
  '<w:style w:type="paragraph" w:styleId="CodeBlock"><w:name w:val="Code Block"/><w:basedOn w:val="Normal"/>' +
  '<w:uiPriority w:val="39"/><w:qFormat/><w:pPr><w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/>' +
  '<w:spacing w:after="160" w:line="240" w:lineRule="auto"/></w:pPr>' +
  `<w:rPr>${fonts(CODE_FONT)}<w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr></w:style>` +
  '<w:style w:type="character" w:styleId="InlineCode"><w:name w:val="Inline Code"/>' +
  '<w:basedOn w:val="DefaultParagraphFont"/><w:uiPriority w:val="39"/><w:qFormat/>' +
  `<w:rPr>${fonts(CODE_FONT)}<w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr></w:style>` +
  '<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/>' +
  '<w:basedOn w:val="DefaultParagraphFont"/><w:uiPriority w:val="99"/><w:unhideWhenUsed/>' +
  '<w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr></w:style>';

const TABLE_GRID =
  '<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:basedOn w:val="TableNormal"/>' +
  '<w:uiPriority w:val="39"/><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr>' +
  "<w:tblPr><w:tblBorders>" +
  ["top", "left", "bottom", "right", "insideH", "insideV"]
    .map((side) => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="auto"/>`)
    .join("") +
  "</w:tblBorders></w:tblPr></w:style>";

/** The text of `word/styles.xml`. */
export function stylesXml(): string {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    `<w:styles xmlns:w="${W_NS}">` +
    DOC_DEFAULTS +
    BASE_STYLES +
    HEADINGS.map((look, index) => headingStyle(index + 1, look)).join("") +
    TITLE_STYLES +
    BODY_STYLES +
    TABLE_GRID +
    "</w:styles>"
  );
}
