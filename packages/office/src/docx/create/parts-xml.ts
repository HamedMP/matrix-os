/**
 * The small parts of a new document: numbering, settings, core and extended
 * properties. Element order follows the schemas.
 */

import { escapeXmlText } from "../../xml/index.js";

const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

/** Abstract numbering ids of the two built-in list definitions. */
export const DECIMAL_ABSTRACT_ID = 0;
export const BULLET_ABSTRACT_ID = 1;
/** Numbering instances every new document has: one decimal list, one bullet list. */
export const DECIMAL_NUM_ID = 1;
export const BULLET_NUM_ID = 2;

/** Indents (twips) of the multi-level decimal list: `[left, hanging]` per level. */
const DECIMAL_INDENTS: ReadonlyArray<readonly [number, number]> = [
  [360, 360],
  [792, 432],
  [1224, 504],
  [1728, 648],
  [2232, 792],
  [2736, 936],
  [3240, 1080],
  [3744, 1224],
  [4320, 1440],
];
const BULLETS = ["•", "◦", "▪"];

function decimalLevel(level: number): string {
  const text = Array.from({ length: level + 1 }, (_, index) => `%${index + 1}.`).join("");
  const [left, hanging] = DECIMAL_INDENTS[level] as readonly [number, number];
  return (
    `<w:lvl w:ilvl="${level}"><w:start w:val="1"/><w:numFmt w:val="decimal"/>` +
    `<w:lvlText w:val="${text}"/><w:lvlJc w:val="left"/>` +
    `<w:pPr><w:ind w:left="${left}" w:hanging="${hanging}"/></w:pPr></w:lvl>`
  );
}

function bulletLevel(level: number): string {
  const symbol = BULLETS[level % BULLETS.length] as string;
  return (
    `<w:lvl w:ilvl="${level}"><w:start w:val="1"/><w:numFmt w:val="bullet"/>` +
    `<w:lvlText w:val="${symbol}"/><w:lvlJc w:val="left"/>` +
    `<w:pPr><w:ind w:left="${720 * (level + 1)}" w:hanging="360"/></w:pPr></w:lvl>`
  );
}

const LEVELS = [0, 1, 2, 3, 4, 5, 6, 7, 8];

/** A numbering instance: its id, the abstract list it uses and an optional start for level 0. */
export interface NumberingInstance {
  numId: number;
  abstractId: number;
  start?: number;
}

/** The text of `word/numbering.xml` with the given instances. */
export function numberingXml(instances: readonly NumberingInstance[]): string {
  const abstract = (id: number, nsid: string, type: string, name: string, level: (level: number) => string): string =>
    `<w:abstractNum w:abstractNumId="${id}"><w:nsid w:val="${nsid}"/><w:multiLevelType w:val="${type}"/>` +
    `<w:name w:val="${name}"/>${LEVELS.map(level).join("")}</w:abstractNum>`;
  const nums = instances
    .map((instance) => {
      const override =
        instance.start === undefined
          ? ""
          : `<w:lvlOverride w:ilvl="0"><w:startOverride w:val="${instance.start}"/></w:lvlOverride>`;
      return `<w:num w:numId="${instance.numId}"><w:abstractNumId w:val="${instance.abstractId}"/>${override}</w:num>`;
    })
    .join("");
  return (
    DECLARATION +
    `<w:numbering xmlns:w="${W_NS}">` +
    abstract(DECIMAL_ABSTRACT_ID, "4D41544E", "multilevel", "Numbered List", decimalLevel) +
    abstract(BULLET_ABSTRACT_ID, "4D415442", "hybridMultilevel", "Bulleted List", bulletLevel) +
    nums +
    "</w:numbering>"
  );
}

/** The text of `word/settings.xml`. */
export function settingsXml(): string {
  return (
    DECLARATION +
    `<w:settings xmlns:w="${W_NS}">` +
    '<w:zoom w:percent="100"/><w:defaultTabStop w:val="720"/>' +
    '<w:characterSpacingControl w:val="doNotCompress"/>' +
    "<w:compat>" +
    '<w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/>' +
    "</w:compat></w:settings>"
  );
}

/** Core properties of a new document; absent values are left out. */
export interface CoreValues {
  title?: string;
  author?: string;
  date?: string;
}

/** The text of `docProps/core.xml`. */
export function corePropertiesXml(values: CoreValues): string {
  let content = "";
  if (values.title !== undefined) content += `<dc:title>${escapeXmlText(values.title)}</dc:title>`;
  if (values.author !== undefined) {
    const author = escapeXmlText(values.author);
    content += `<dc:creator>${author}</dc:creator><cp:lastModifiedBy>${author}</cp:lastModifiedBy>`;
  }
  if (values.date !== undefined) {
    const date = escapeXmlText(values.date);
    content +=
      `<dcterms:created xsi:type="dcterms:W3CDTF">${date}</dcterms:created>` +
      `<dcterms:modified xsi:type="dcterms:W3CDTF">${date}</dcterms:modified>`;
  }
  return (
    DECLARATION +
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
    'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ' +
    'xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
    content +
    "</cp:coreProperties>"
  );
}

/** The text of `docProps/app.xml`. */
export function appPropertiesXml(): string {
  return (
    DECLARATION +
    '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" ' +
    'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">' +
    "<Application>Matrix OS</Application><DocSecurity>0</DocSecurity></Properties>"
  );
}
