import { Dropdown, type DropdownItem, EmptyState, KeyHint, ReviewBar } from "../../../../_shared/office-ui";
import { REVIEW_SHORTCUTS, type ReviewController } from "../../review/index";
import { ReviewFilters } from "./ReviewFilters";
import { RevisionList } from "./RevisionList";
import { useReviewSnapshot } from "./use-review";
import "./review.css";

export interface ReviewPanelProps {
  controller: ReviewController;
  /** Disables the actions, for example while the document is read-only. */
  busy?: boolean;
  className?: string;
}

const MORE_ACTIONS: DropdownItem[] = [
  { id: "accept-selection", label: "Accept changes in selection" },
  { id: "reject-selection", label: "Reject changes in selection" },
  { id: "accept-formatting", label: "Accept formatting, keep the rest", separatorBefore: true },
];

/**
 * Tracked revisions: a review bar to step through them, filters, the list
 * grouped by author, and bulk actions. Every action goes through the session
 * and can be undone.
 */
export function ReviewPanel({ controller, busy = false, className }: ReviewPanelProps) {
  const snapshot = useReviewSnapshot(controller);
  const { visible, items, current, currentIndex, formattingCount, filtered, error } = snapshot;
  const detail = current === null ? (filtered ? `${visible.length} of ${items.length} shown` : null) : `${current.kindLabel} · ${current.author}`;

  const runMore = (id: string) => {
    if (id === "accept-selection") controller.acceptSelection();
    else if (id === "reject-selection") controller.rejectSelection();
    else if (id === "accept-formatting") controller.acceptFormatting();
  };

  return (
    <section className={className === undefined ? "docs-review" : `docs-review ${className}`} aria-label="Tracked changes">
      <ReviewBar
        total={visible.length}
        index={currentIndex}
        noun="revision"
        detail={detail}
        busy={busy}
        onPrevious={() => controller.previous()}
        onNext={() => controller.next()}
        onAccept={() => controller.accept()}
        onReject={() => controller.reject()}
        onAcceptAll={() => controller.acceptAll()}
        onRejectAll={() => controller.rejectAll()}
      />
      {error !== null && (
        <div className="docs-review__error" role="alert">
          <span>{error}</span>
          <button type="button" className="oui-button oui-button--ghost" onClick={() => controller.dismissError()}>
            Dismiss
          </button>
        </div>
      )}
      {items.length === 0 ? (
        <EmptyState
          headline="No tracked changes"
          description="Turn on Track changes to record edits as revisions. Changes from the agent and other authors appear here for review."
        />
      ) : (
        <>
          <ReviewFilters controller={controller} snapshot={snapshot} />
          <div className="docs-review__bulk">
            <button
              type="button"
              className="oui-button"
              disabled={busy || formattingCount === 0}
              title="Accept every formatting change and keep text changes for review"
              onClick={() => controller.acceptFormatting()}
            >
              Accept formatting, keep substantive ({formattingCount})
            </button>
            <Dropdown label="More" ariaLabel="More review actions" items={MORE_ACTIONS.map((item) => ({ ...item, disabled: busy || (item.id === "accept-formatting" && formattingCount === 0) }))} onSelect={runMore} align="end" />
          </div>
          {filtered && <p className="docs-review__note">Accept all and Reject all apply to the {visible.length} shown {visible.length === 1 ? "change" : "changes"}.</p>}
          {visible.length === 0 ? (
            <p className="docs-review__note">No changes match these filters.</p>
          ) : (
            <RevisionList groups={snapshot.groups} currentId={current?.id ?? null} controller={controller} busy={busy} />
          )}
          <p className="docs-review__keys">
            <KeyHint keys={REVIEW_SHORTCUTS.next} /> next · <KeyHint keys={REVIEW_SHORTCUTS.previous} /> previous · <KeyHint keys={REVIEW_SHORTCUTS.accept} /> accept ·{" "}
            <KeyHint keys={REVIEW_SHORTCUTS.reject} /> reject
          </p>
        </>
      )}
    </section>
  );
}
