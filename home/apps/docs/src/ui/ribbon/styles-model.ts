/** The paragraph styles the Styles gallery offers and which one the caret is in. */

import type { CSSProperties } from "react";
import type { ParagraphStylePatch } from "../../../../_shared/office-engine/index";
import type { ActiveFormat } from "../../editor/index";
import type { DocumentStyle } from "./caret-format";

export interface StyleChoice {
  id: string;
  label: string;
  patch: Partial<ParagraphStylePatch>;
  preview?: CSSProperties;
}

/**
 * Headings come from `headingLevel`, which the engine creates when the file
 * lacks the style; the others need the style in the file, and applying one a
 * file does not have is reported to the owner.
 */
export const BUILT_IN_STYLES: readonly StyleChoice[] = Object.freeze([
  { id: "normal", label: "Normal", patch: { headingLevel: 0 } },
  { id: "title", label: "Title", patch: { styleId: "Title" }, preview: { fontSize: 18, fontWeight: 300 } },
  { id: "subtitle", label: "Subtitle", patch: { styleId: "Subtitle" }, preview: { fontStyle: "italic" } },
  { id: "h1", label: "Heading 1", patch: { headingLevel: 1 }, preview: { fontSize: 16, fontWeight: 600 } },
  { id: "h2", label: "Heading 2", patch: { headingLevel: 2 }, preview: { fontSize: 14, fontWeight: 600 } },
  { id: "h3", label: "Heading 3", patch: { headingLevel: 3 }, preview: { fontSize: 13, fontWeight: 600 } },
  { id: "h4", label: "Heading 4", patch: { headingLevel: 4 }, preview: { fontWeight: 600, fontStyle: "italic" } },
  { id: "quote", label: "Quote", patch: { styleId: "Quote" }, preview: { fontStyle: "italic" } },
  { id: "list", label: "List Paragraph", patch: { styleId: "ListParagraph" } },
  { id: "code", label: "Code Block", patch: { styleId: "CodeBlock" }, preview: { fontFamily: "monospace" } },
]);

const BUILT_IN_STYLE_IDS = new Set(["Normal", "Title", "Subtitle", "Quote", "ListParagraph", "CodeBlock"]);

/** The built-in styles, then the other paragraph styles the document uses. */
export function styleChoices(documentStyles: readonly DocumentStyle[]): StyleChoice[] {
  const extra = documentStyles
    .filter((style) => !BUILT_IN_STYLE_IDS.has(style.styleId))
    .map((style) => ({ id: `doc:${style.styleId}`, label: style.name, patch: { styleId: style.styleId } }));
  return [...BUILT_IN_STYLES, ...extra];
}

/** The gallery entry of the caret's paragraph, or undefined for a mixed selection or a style not offered. */
export function currentStyleId(format: ActiveFormat | null, choices: readonly StyleChoice[]): string | undefined {
  if (format === null || format.headingLevel === null) return undefined;
  if (format.headingLevel > 0) return choices.find((choice) => choice.patch.headingLevel === format.headingLevel)?.id;
  const name = format.styleName;
  if (name === null || name === "Normal") return "normal";
  return choices.find((choice) => choice.label === name)?.id;
}
