/**
 * Defined terms and cross-references in the document: painted as editor
 * highlights; hovering one shows its definition or the referenced clause;
 * clicking jumps there and offers a way back.
 */

import { ArrowLeft } from "lucide-react";
import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
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

interface Found {
  element: HTMLElement;
  id: string;
  info: ReferenceInfo;
  from: TextRange | null;
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

  // The workspace remounts this layer for every document (keyed by it), so the way back never leads into another one.
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelHide = () => {
    if (hideTimer.current !== null) clearTimeout(hideTimer.current);
    hideTimer.current = null;
  };
  const scheduleHide = () => {
    if (hideTimer.current !== null) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setCard(null), HIDE_DELAY_MS);
  };
  useEffect(
    () => () => {
      if (hideTimer.current !== null) clearTimeout(hideTimer.current);
      if (flashTimer.current !== null) clearTimeout(flashTimer.current);
    },
    [],
  );

  const jump = (info: ReferenceInfo, from: TextRange | null) => {
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
      if (flashTimer.current !== null) clearTimeout(flashTimer.current);
      flashTimer.current = setTimeout(() => editor.clearHighlights(JUMP_LAYER), JUMP_FLASH_MS);
    }
  };

  const referenceAt = (target: EventTarget | null): Found | null => {
    if (index === null) return null;
    const element = target instanceof Element ? (target.closest(REFERENCE_SELECTOR) as HTMLElement | null) : null;
    if (element === null) return null;
    for (const id of referenceIdsAt(element)) {
      const info = referenceInfo(index, id);
      if (info !== null) return { element, id, info, from: index.ranges.get(id) ?? null };
    }
    return null;
  };

  const onOver = useEffectEvent((event: MouseEvent) => {
    const found = referenceAt(event.target);
    if (found === null) return;
    cancelHide();
    const rect = found.element.getBoundingClientRect();
    setCard((previous) => (previous?.id === found.id ? previous : { id: found.id, info: found.info, from: found.from, top: rect.bottom + 6, left: rect.left }));
  });
  const onOut = useEffectEvent((event: MouseEvent) => {
    if (referenceAt(event.target) === null || referenceAt(event.relatedTarget) !== null) return;
    scheduleHide();
  });
  const onClick = useEffectEvent((event: MouseEvent) => {
    if (event.button !== 0 || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return;
    const found = referenceAt(event.target);
    if (found === null) return;
    // A drag that selected text is a selection, not a jump.
    const selection = editor?.getSelection();
    if (selection !== null && selection !== undefined && !selection.collapsed) return;
    jump(found.info, found.from);
  });

  useEffect(() => {
    if (container === null) return undefined;
    const over = (event: MouseEvent) => onOver(event);
    const out = (event: MouseEvent) => onOut(event);
    const click = (event: MouseEvent) => onClick(event);
    container.addEventListener("mouseover", over);
    container.addEventListener("mouseout", out);
    container.addEventListener("click", click);
    return () => {
      container.removeEventListener("mouseover", over);
      container.removeEventListener("mouseout", out);
      container.removeEventListener("click", click);
    };
  }, [container]);

  const shown = card !== null;
  useEffect(() => {
    if (!shown) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (hideTimer.current !== null) clearTimeout(hideTimer.current);
      hideTimer.current = null;
      setCard(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [shown]);

  const goBack = () => {
    const previous = back[back.length - 1];
    if (previous === undefined || editor === null) return;
    setBack((stack) => stack.slice(0, -1));
    editor.setSelection(previous, { scroll: true, focus: true });
  };

  return (
    <>
      {card !== null && (
        // Non-modal: the document stays usable while the card is shown.
        <dialog open aria-label={cardTitle(card.info)} className="docs-refcard" style={{ top: card.top, left: card.left }} onMouseEnter={cancelHide} onMouseLeave={scheduleHide}>
          <ReferenceCardBody info={card.info} onJump={() => jump(card.info, card.from)} />
        </dialog>
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
