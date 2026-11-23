/**
 * Defined terms and cross-references in the document: painted as editor
 * highlights; hovering one shows its definition or the referenced clause;
 * clicking jumps there and offers a way back.
 */

import { ArrowLeft } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TextRange } from "../../../_shared/office-engine/index";
import type { DocumentEditorController } from "../editor/index";
import type { DocumentSession } from "../session/index";
import { type ReferenceInfo, TERMS_LAYER, XREFS_LAYER, buildReferenceIndex, referenceIdsAt, referenceInfo } from "./references-model";

const JUMP_LAYER = "jump";
const MAX_BACK_STEPS = 20;
const HIDE_DELAY_MS = 200;
const JUMP_FLASH_MS = 1_600;
const REFERENCE_SELECTOR = `.doc-hl-${TERMS_LAYER}, .doc-hl-${XREFS_LAYER}`;

export interface ReferenceLayerProps {
  session: DocumentSession;
  editor: DocumentEditorController | null;
  docVersion: number;
  /** The element around the editor; hover and click events are read there. */
  container: HTMLElement | null;
}

interface Place {
  anchor: TextRange["start"];
  focus: TextRange["start"];
}

interface Card {
  id: string;
  info: ReferenceInfo;
  /** Where the reference itself is: the place to come back to. */
  from: TextRange | null;
  top: number;
  left: number;
}

function cardTitle(info: ReferenceInfo): string {
  return info.kind === "term" ? `Definition of ${info.term}` : `Reference ${info.text}`;
}

export function ReferenceLayer({ session, editor, docVersion, container }: ReferenceLayerProps) {
  const [card, setCard] = useState<Card | null>(null);
  const [back, setBack] = useState<Place[]>([]);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const index = useMemo(() => {
    const doc = session.document;
    return doc === null ? null : buildReferenceIndex(doc);
    // docVersion stands for the document content.
  }, [session, docVersion]);

  useEffect(() => {
    if (editor === null || index === null) return undefined;
    editor.setHighlights(TERMS_LAYER, index.terms);
    editor.setHighlights(XREFS_LAYER, index.xrefs);
    return () => {
      editor.clearHighlights(TERMS_LAYER);
      editor.clearHighlights(XREFS_LAYER);
    };
  }, [editor, index]);

  // A new document has no way back into the old one.
  useEffect(() => {
    setBack([]);
    setCard(null);
  }, [session, session.getState().documentKey]);

  const cancelHide = () => {
    if (hideTimer.current !== null) clearTimeout(hideTimer.current);
    hideTimer.current = null;
  };
  const scheduleHide = useCallback(() => {
    if (hideTimer.current !== null) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setCard(null), HIDE_DELAY_MS);
  }, []);
  useEffect(() => () => cancelHide(), []);

  const jump = useCallback(
    (info: ReferenceInfo, from: TextRange | null) => {
      if (editor === null) return;
      const target = info.kind === "term" ? info.target : info.targetBlockId === null ? null : { start: { blockId: info.targetBlockId, offset: 0 }, end: { blockId: info.targetBlockId, offset: 0 } };
      if (target === null) return;
      const selection = editor.getSelection();
      const here: Place | null = from !== null ? { anchor: from.start, focus: from.start } : selection === null ? null : { anchor: selection.anchor, focus: selection.focus };
      if (here !== null) setBack((stack) => [...stack, here].slice(-MAX_BACK_STEPS));
      setCard(null);
      editor.setSelection(info.kind === "term" ? target : target.start, { scroll: true });
      editor.scrollTo(info.kind === "term" ? target : target.start.blockId, { block: "center", behavior: "smooth" });
      if (info.kind === "term") {
        editor.setHighlights(JUMP_LAYER, [{ range: target }]);
        setTimeout(() => editor.clearHighlights(JUMP_LAYER), JUMP_FLASH_MS);
      }
    },
    [editor],
  );

  useEffect(() => {
    if (container === null || index === null) return undefined;
    const referenceAt = (target: EventTarget | null): { element: HTMLElement; id: string; info: ReferenceInfo; from: TextRange | null } | null => {
      const element = target instanceof Element ? (target.closest(REFERENCE_SELECTOR) as HTMLElement | null) : null;
      if (element === null) return null;
      for (const id of referenceIdsAt(element)) {
        const info = referenceInfo(index, id);
        if (info !== null) return { element, id, info, from: index.ranges.get(id) ?? null };
      }
      return null;
    };
    const onOver = (event: MouseEvent) => {
      const found = referenceAt(event.target);
      if (found === null) return;
      cancelHide();
      const rect = found.element.getBoundingClientRect();
      setCard((previous) => (previous?.id === found.id ? previous : { id: found.id, info: found.info, from: found.from, top: rect.bottom + 6, left: rect.left }));
    };
    const onOut = (event: MouseEvent) => {
      if (referenceAt(event.target) === null) return;
      if (referenceAt(event.relatedTarget) !== null) return;
      scheduleHide();
    };
    const onClick = (event: MouseEvent) => {
      if (event.button !== 0 || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return;
      const found = referenceAt(event.target);
      if (found === null) return;
      // A drag that selected text is a selection, not a jump.
      const selection = editor?.getSelection();
      if (selection !== null && selection !== undefined && !selection.collapsed) return;
      jump(found.info, found.from);
    };
    container.addEventListener("mouseover", onOver);
    container.addEventListener("mouseout", onOut);
    container.addEventListener("click", onClick);
    return () => {
      container.removeEventListener("mouseover", onOver);
      container.removeEventListener("mouseout", onOut);
      container.removeEventListener("click", onClick);
    };
  }, [container, index, editor, jump, scheduleHide]);

  const goBack = () => {
    const previous = back[back.length - 1];
    if (previous === undefined || editor === null) return;
    setBack((stack) => stack.slice(0, -1));
    editor.setSelection(previous, { scroll: true, focus: true });
  };

  return (
    <>
      {card !== null && (
        <div
          role="dialog"
          aria-label={cardTitle(card.info)}
          className="docs-refcard"
          style={{ top: card.top, left: card.left }}
          onMouseEnter={cancelHide}
          onMouseLeave={scheduleHide}
        >
          <ReferenceCardBody info={card.info} onJump={() => jump(card.info, card.from)} />
        </div>
      )}
      {back.length > 0 && (
        <button type="button" className="oui-button docs-back" onClick={goBack}>
          <ArrowLeft size={14} aria-hidden="true" />
          Back
        </button>
      )}
    </>
  );
}

function ReferenceCardBody({ info, onJump }: { info: ReferenceInfo; onJump: () => void }) {
  if (info.kind === "term") {
    return (
      <>
        <p className="docs-refcard__kind">Defined term</p>
        <p className="docs-refcard__title">“{info.term}”</p>
        <p className="docs-refcard__text">{info.definition}</p>
        <button type="button" className="oui-button oui-button--ghost" onClick={onJump}>
          Go to definition
        </button>
      </>
    );
  }
  return (
    <>
      <p className="docs-refcard__kind">Cross-reference</p>
      <p className="docs-refcard__title">{info.text}</p>
      {info.broken || info.targetBlockId === null ? (
        <p className="docs-refcard__text docs-refcard__text--broken">The clause this refers to was not found in the document.</p>
      ) : (
        <>
          <p className="docs-refcard__text">
            {info.label !== null && <span className="docs-refcard__label">{info.label} </span>}
            {info.preview ?? ""}
          </p>
          <button type="button" className="oui-button oui-button--ghost" onClick={onJump}>
            Go to clause
          </button>
        </>
      )}
    </>
  );
}
