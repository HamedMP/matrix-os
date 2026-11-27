/**
 * Carries a selection through accepting or rejecting revisions, which the
 * engine does without mapping positions. Accepting a deletion or rejecting an
 * insertion removes that text; everything else in a paragraph keeps its
 * order. A position therefore moves back by the removed text before it, and
 * one inside removed text moves to where that text was.
 *
 * The paragraph is checked afterwards: it must still exist and start with the
 * text that was expected to stay. When it does not (it was removed, or joined
 * into the paragraph before it) the position cannot be found and the
 * selection is lost.
 */

import type { DocxDocument, InlineRun, ParagraphBlock, ResolveRevisionsResult, TextPosition } from "../../../_shared/office-engine/index";
import type { SessionSelection } from "./types";

interface Endpoint {
  position: TextPosition;
  runs: readonly InlineRun[];
}

function paragraphOf(doc: DocxDocument, blockId: string): ParagraphBlock | null {
  const block = doc.getBlock(blockId);
  return block !== null && block.type === "paragraph" ? block : null;
}

/** True when resolving the run's revision (when it was resolved) removes the run's text. */
function removes(run: InlineRun, accept: boolean, resolved: ReadonlySet<string>): boolean {
  const revision = run.revision;
  if (revision === null || !resolved.has(revision.revisionId)) return false;
  const inserted = revision.kind === "insert" || revision.kind === "moveTo";
  const deleted = revision.kind === "delete" || revision.kind === "moveFrom";
  return accept ? deleted : inserted;
}

function carry(doc: DocxDocument, endpoint: Endpoint, accept: boolean, resolved: ReadonlySet<string>): TextPosition | null {
  let offset = 0;
  let kept = "";
  for (const run of endpoint.runs) {
    if (removes(run, accept, resolved)) continue;
    kept += run.text;
    offset += Math.max(0, Math.min(run.text.length, endpoint.position.offset - run.start));
  }
  const after = paragraphOf(doc, endpoint.position.blockId);
  if (after === null || !after.text.startsWith(kept)) return null;
  return { blockId: endpoint.position.blockId, offset };
}

/**
 * Reads what `selection` needs before revisions are resolved and returns the
 * function that finds it afterwards, or returns null there when an end cannot
 * be found.
 */
export function trackSelectionThroughResolve(
  doc: DocxDocument,
  selection: SessionSelection,
  accept: boolean,
): (result: ResolveRevisionsResult) => SessionSelection | null {
  const endpoint = (position: TextPosition): Endpoint | null => {
    const block = paragraphOf(doc, position.blockId);
    return block === null ? null : { position, runs: block.runs };
  };
  const anchor = endpoint(selection.anchor);
  const focus = endpoint(selection.focus);
  return (result) => {
    if (anchor === null || focus === null) return null;
    const resolved = new Set<string>(result.resolvedIds);
    const carriedAnchor = carry(doc, anchor, accept, resolved);
    const carriedFocus = carry(doc, focus, accept, resolved);
    return carriedAnchor === null || carriedFocus === null ? null : { anchor: carriedAnchor, focus: carriedFocus };
  };
}
