import { useCallback, useEffect, useState } from "react";
import { Badge, EmptyState, ReviewBar } from "../../../../_shared/office-ui";
import type { ReviewGroup, ReviewState, SheetReviewController } from "../../review";
import { ChangeRow } from "./ChangeRow";
import { useMarkupOverlay } from "./markup-overlay";
import { useMarkupMap, useReviewState } from "./use-review";
import "./review.css";

/** Rows drawn per proposal; the review bar still steps through every change. */
export const MAX_ROWS_PER_GROUP = 300;

export interface SheetReviewPanelProps {
  review: SheetReviewController;
  /**
   * The grid's root element (`.sheet-grid`), where markup draws old values
   * struck through. Defaults to the first `.sheet-grid` in the document.
   */
  gridElement?: HTMLElement | null;
  onClose?: () => void;
  className?: string;
}

function formatDate(iso: string): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return "";
  return new Date(time).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** The ReviewBar wired to the controller, for the panel or for `AppFrame`'s banner. */
export function SheetReviewBar({ review, className }: { review: SheetReviewController; className?: string }) {
  const state = useReviewState(review);
  const current = state.current;
  return (
    <ReviewBar
      className={className}
      total={state.total}
      index={state.index}
      noun="cell change"
      onPrevious={() => review.previous()}
      onNext={() => review.next()}
      onAccept={() => review.acceptCurrent()}
      onReject={() => review.rejectCurrent()}
      onAcceptAll={() => review.accept("all")}
      onRejectAll={() => review.reject("all")}
      detail={current === null ? undefined : `${current.location} · ${current.author}`}
    />
  );
}

function GroupHeader({ group, review }: { group: ReviewGroup; review: SheetReviewController }) {
  const ids = group.items.map((item) => item.id);
  const date = formatDate(group.date);
  return (
    <div className="sheets-review__group-head">
      <div className="sheets-review__group-title">
        <strong>{group.label === "" ? "Proposed changes" : group.label}</strong>
        <span className="sheets-review__group-meta">
          {group.author}
          {date !== "" && ` · ${date}`}
        </span>
      </div>
      <Badge tone="accent">{group.items.length}</Badge>
      <button type="button" className="oui-button oui-button--ghost" onClick={() => review.accept(ids)} aria-label={`Accept all changes of ${group.label}`}>
        Accept all
      </button>
      <button type="button" className="oui-button oui-button--ghost" onClick={() => review.reject(ids)} aria-label={`Reject all changes of ${group.label}`}>
        Reject all
      </button>
    </div>
  );
}

function SelectionBar({ state, review }: { state: ReviewState; review: SheetReviewController }) {
  const count = state.selectedIds.length;
  if (count === 0) return null;
  return (
    <div className="sheets-review__selection" role="group" aria-label="Selected changes">
      <span>{count === 1 ? "1 change selected" : `${count} changes selected`}</span>
      <button type="button" className="oui-button oui-button--success" onClick={() => review.accept("selection")}>
        Accept selected
      </button>
      <button type="button" className="oui-button oui-button--danger" onClick={() => review.reject("selection")}>
        Reject selected
      </button>
      <button type="button" className="oui-button oui-button--ghost" onClick={() => review.clearSelection()}>
        Clear
      </button>
    </div>
  );
}

/**
 * The list of proposed cell changes, grouped by proposal, with a Markup
 * toggle, stepping, and accepting or rejecting one, a selection or all.
 */
export function SheetReviewPanel({ review, gridElement, onClose, className }: SheetReviewPanelProps) {
  const state = useReviewState(review);
  const markupMap = useMarkupMap(state);
  const [fallbackRoot, setFallbackRoot] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (gridElement !== undefined) return;
    setFallbackRoot(document.querySelector<HTMLElement>(".sheet-grid"));
  }, [gridElement]);
  useMarkupOverlay(gridElement === undefined ? fallbackRoot : gridElement, markupMap);

  const selected = new Set(state.selectedIds);
  const onSelect = useCallback((id: string, on: boolean) => review.toggleSelected(id, on), [review]);
  const onGoTo = useCallback((id: string) => review.goTo(id), [review]);
  const onAccept = useCallback((id: string) => review.accept([id]), [review]);
  const onReject = useCallback((id: string) => review.reject([id]), [review]);

  return (
    <section className={`sheets-review${className === undefined ? "" : ` ${className}`}`} aria-label="Review changes">
      <header className="sheets-review__head">
        <h2 className="sheets-review__title">Changes</h2>
        <Badge tone={state.total > 0 ? "warning" : "neutral"}>{state.total}</Badge>
        <button type="button" className="oui-button oui-button--ghost sheets-review__markup" aria-pressed={state.markup} onClick={() => review.toggleMarkup()}>
          Markup
        </button>
        {onClose !== undefined && (
          <button type="button" className="oui-icon-button" aria-label="Close review" onClick={onClose}>
            ×
          </button>
        )}
      </header>
      <SheetReviewBar review={review} className="sheets-review__bar" />
      {state.notice !== null && (
        <p className="sheets-review__notice" role="status">
          {state.notice}
        </p>
      )}
      <SelectionBar state={state} review={review} />
      {state.total === 0 ? (
        <EmptyState headline="No changes to review" description="Changes proposed by the assistant or by others appear here with their old and new values." />
      ) : (
        <div className="sheets-review__groups">
          {state.groups.map((group) => (
            <section key={group.proposalId} className="sheets-review__group" aria-label={`${group.label} by ${group.author}`}>
              <GroupHeader group={group} review={review} />
              <ul className="sheets-review__list">
                {group.items.slice(0, MAX_ROWS_PER_GROUP).map((item) => (
                  <ChangeRow
                    key={item.id}
                    item={item}
                    current={item.id === state.currentId}
                    selected={selected.has(item.id)}
                    onSelect={onSelect}
                    onGoTo={onGoTo}
                    onAccept={onAccept}
                    onReject={onReject}
                  />
                ))}
              </ul>
              {group.items.length > MAX_ROWS_PER_GROUP && (
                <p className="sheets-review__more">{group.items.length - MAX_ROWS_PER_GROUP} more changes: use the arrows above to step through them.</p>
              )}
            </section>
          ))}
        </div>
      )}
    </section>
  );
}
