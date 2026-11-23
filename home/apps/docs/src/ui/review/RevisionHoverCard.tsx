import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { type ReviewController, type ReviewItem, formatReviewDate } from "../../review/index";
import { hoverTargetOf, placeCard } from "./hover-target";
import { useReviewSnapshot } from "./use-review";
import "./review.css";

/** Pause before the card hides, so the pointer can move from the text onto it. */
export const HOVER_HIDE_DELAY_MS = 250;
/** Pause before the card shows, so passing over marked text does not flash it. */
export const HOVER_SHOW_DELAY_MS = 150;

const FALLBACK_SIZE = { width: 280, height: 140 };

export interface RevisionHoverCardProps {
  controller: ReviewController;
  /** The element around the editor; pointer events inside it are watched. */
  container: HTMLElement | null;
  /** No card while true, for example in a read-only view. */
  disabled?: boolean;
}

/** The show and hide delays of one card. */
class HoverTimers {
  private show: ReturnType<typeof setTimeout> | null = null;
  private hide: ReturnType<typeof setTimeout> | null = null;

  showSoon(run: () => void): void {
    this.keep();
    this.clearShow();
    this.show = setTimeout(() => {
      this.show = null;
      run();
    }, HOVER_SHOW_DELAY_MS);
  }

  hideSoon(run: () => void): void {
    this.clearShow();
    if (this.hide !== null) return;
    this.hide = setTimeout(() => {
      this.hide = null;
      run();
    }, HOVER_HIDE_DELAY_MS);
  }

  /** Cancels a pending hide (the pointer came back). */
  keep(): void {
    if (this.hide !== null) clearTimeout(this.hide);
    this.hide = null;
  }

  cancel(): void {
    this.keep();
    this.clearShow();
  }

  private clearShow(): void {
    if (this.show !== null) clearTimeout(this.show);
    this.show = null;
  }
}

interface Shown {
  ids: string[];
  anchor: Element;
}

/**
 * The card that appears over a tracked change in the document: who made it,
 * when, what it is, and Accept and Reject.
 */
export function RevisionHoverCard({ controller, container, disabled = false }: RevisionHoverCardProps) {
  const snapshot = useReviewSnapshot(controller);
  const [shown, setShown] = useState<Shown | null>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const card = useRef<HTMLDivElement>(null);
  const [timers] = useState(() => new HoverTimers());

  useEffect(() => {
    if (container === null || disabled) return undefined;
    const onOver = (event: PointerEvent) => {
      const target = hoverTargetOf(event.target, container);
      if (target === null) timers.hideSoon(() => setShown(null));
      else timers.showSoon(() => setShown({ ids: target.revisionIds, anchor: target.element }));
    };
    const onLeave = () => timers.hideSoon(() => setShown(null));
    container.addEventListener("pointerover", onOver);
    container.addEventListener("pointerleave", onLeave);
    return () => {
      container.removeEventListener("pointerover", onOver);
      container.removeEventListener("pointerleave", onLeave);
      timers.cancel();
    };
  }, [container, disabled, timers]);

  useEffect(() => {
    if (!disabled) return;
    timers.cancel();
    setShown(null);
  }, [disabled, timers]);

  const items: ReviewItem[] = shown === null ? [] : shown.ids.map((id) => snapshot.items.find((item) => item.id === id)).filter((item): item is ReviewItem => item !== undefined);

  useLayoutEffect(() => {
    if (shown === null || items.length === 0) {
      setPosition(null);
      return;
    }
    const rect = shown.anchor.getBoundingClientRect();
    const size = card.current?.getBoundingClientRect();
    const measured = size !== undefined && size.width > 0 ? { width: size.width, height: size.height } : FALLBACK_SIZE;
    setPosition(placeCard(rect, measured, { width: window.innerWidth, height: window.innerHeight }));
    // Measured again when another change is shown or the list of items changes.
  }, [shown, items.length]);

  if (shown === null || items.length === 0) return null;

  const act = (action: "accept" | "reject", id: string) => {
    if (action === "accept") controller.accept(id);
    else controller.reject(id);
    setShown(null);
  };

  return (
    <div
      ref={card}
      className="docs-hovercard"
      role="dialog"
      aria-label="Tracked change"
      style={position === null ? { visibility: "hidden", left: 0, top: 0 } : { left: position.left, top: position.top }}
      onPointerEnter={() => timers.keep()}
      onPointerLeave={() => timers.hideSoon(() => setShown(null))}
      onKeyDown={(event) => {
        if (event.key === "Escape") setShown(null);
      }}
    >
      {items.map((item) => (
        <div key={item.id} className="docs-hovercard__item" data-author-color={item.colorSlot}>
          <div className="docs-hovercard__head">
            <span className="docs-review__swatch" aria-hidden="true" />
            <span className="docs-hovercard__author">{item.author}</span>
            <span className="docs-hovercard__date">{formatReviewDate(item.date)}</span>
          </div>
          <div className="docs-hovercard__kind">{item.kindLabel}</div>
          <div className={`docs-hovercard__text docs-review__item-text--${item.kind}`}>{item.summary}</div>
          <div className="docs-hovercard__actions">
            <button type="button" className="oui-button oui-button--success" onClick={() => act("accept", item.id)}>
              Accept
            </button>
            <button type="button" className="oui-button oui-button--danger" onClick={() => act("reject", item.id)}>
              Reject
            </button>
            <button type="button" className="oui-button oui-button--ghost" onClick={() => controller.select(item.id)}>
              Show in list
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
