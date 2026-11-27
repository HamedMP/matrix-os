/**
 * `toPlainText`: the body as plain text, with numbering labels.
 *
 * The layout is the one `getPlainText` uses (paragraphs end with `\n`, table
 * cells are separated by `\t` and rows by `\n`, inline objects are left out),
 * so with `numberingLabels: false` the two agree. With labels, each numbered
 * paragraph starts with its label and a tab.
 */

import type { DocxDocument } from "../../api/docx.js";
import type { DocxTextView, InlineRun } from "../../api/docx-model.js";
import { OfficeError } from "../../errors.js";
import { type FlatBlock, type FlatParagraph, flattenBlocks } from "./flatten.js";
import { runFilterFor } from "./visibility.js";

export interface PlainTextExportOptions {
  /** Default `final`. */
  view?: DocxTextView;
  /** Start numbered paragraphs with their label and a tab. Default true. */
  numberingLabels?: boolean;
}

const VIEWS: ReadonlySet<string> = new Set(["markup", "final", "original"]);

/** The text of runs without inline objects. */
export function runsText(runs: readonly InlineRun[]): string {
  let text = "";
  for (const run of runs) if (run.object === null && run.footnoteRef === null) text += run.text;
  return text;
}

function paragraphText(paragraph: FlatParagraph, labels: boolean): string {
  const label = labels && paragraph.block.numbering !== null ? `${paragraph.block.numbering.text}\t` : "";
  return label + runsText(paragraph.runs);
}

function blocksText(blocks: readonly FlatBlock[], labels: boolean): string {
  let text = "";
  for (const block of blocks) {
    if (block.type === "paragraph") {
      text += `${paragraphText(block, labels)}\n`;
    } else if (block.type === "table") {
      for (const row of block.rows) {
        // Cells hidden by a vertical merge still take their place in the row, as in `getPlainText`.
        const cells = row.slots.map(({ flat }) => {
          if (flat === null) return "";
          const inner = blocksText(flat.blocks, labels);
          return inner.endsWith("\n") ? inner.slice(0, -1) : inner;
        });
        text += `${cells.join("\t")}\n`;
      }
    }
  }
  return text;
}

/** The body as plain text in a view. */
export function toPlainText(doc: DocxDocument, options: PlainTextExportOptions = {}): string {
  const view = options.view ?? "final";
  if (!VIEWS.has(view)) throw new OfficeError("invalid_argument", "unknown text view");
  return blocksText(flattenBlocks(doc.getView().body.blocks, view, runFilterFor(doc)), options.numberingLabels !== false);
}
