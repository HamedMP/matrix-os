/** The outline pane: headings and numbered clauses; click to go there, the current one is marked. */

import { useMemo } from "react";
import type { BlockId } from "../../../_shared/office-engine/index";
import type { DocumentEditorController } from "../editor/index";
import type { DocumentSession } from "../session/index";
import { blockOrder, buildOutline, currentOutlineEntry } from "./outline-model";

export interface OutlinePaneProps {
  session: DocumentSession;
  editor: DocumentEditorController | null;
  docVersion: number;
  /** The block the caret is in. */
  caretBlockId: BlockId | null;
}

export function OutlinePane({ session, editor, docVersion, caretBlockId }: OutlinePaneProps) {
  const { entries, order } = useMemo(() => {
    const doc = session.document;
    if (doc === null) return { entries: [], order: new Map<BlockId, number>() };
    return { entries: buildOutline(doc), order: blockOrder(doc) };
    // docVersion stands for the document content.
  }, [session, docVersion]);
  const current = currentOutlineEntry(entries, order, caretBlockId);

  const go = (blockId: BlockId) => {
    if (editor === null) return;
    editor.setSelection({ blockId, offset: 0 }, { focus: true });
    editor.scrollTo(blockId, { block: "start", behavior: "smooth" });
  };

  return (
    <div className="docs-outline">
      <h2 className="docs-pane-heading">Outline</h2>
      {entries.length === 0 ? (
        <p className="docs-muted docs-outline__empty">Headings and numbered clauses appear here.</p>
      ) : (
        <ul className="docs-outline__list">
          {entries.map((entry) => (
            <li key={entry.blockId}>
              <button
                type="button"
                className={`docs-outline__item docs-outline__item--${entry.kind}`}
                style={{ paddingInlineStart: `${8 + (entry.level - 1) * 12}px` }}
                aria-current={entry.blockId === current ? "location" : undefined}
                onClick={() => go(entry.blockId)}
              >
                {entry.label !== null && <span className="docs-outline__label">{entry.label}</span>}
                <span className="docs-outline__text">{entry.text}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
