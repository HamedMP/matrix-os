import { useEffect, useRef } from "react";
import { Badge } from "../../../../_shared/office-ui";
import { type AuthorGroup, type ReviewController, type ReviewItem, formatReviewDate } from "../../review/index";

const KIND_TONES: Record<ReviewItem["kind"], "success" | "danger" | "accent" | "warning"> = {
  insert: "success",
  delete: "danger",
  moveFrom: "accent",
  moveTo: "accent",
  format: "warning",
};

interface RevisionRowProps {
  item: ReviewItem;
  current: boolean;
  busy: boolean;
  controller: ReviewController;
}

function RevisionRow({ item, current, busy, controller }: RevisionRowProps) {
  const row = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (current && typeof row.current?.scrollIntoView === "function") row.current.scrollIntoView({ block: "nearest" });
  }, [current]);
  const label = `${item.kindLabel} by ${item.author}: ${item.summary}`;
  return (
    <li ref={row} className={current ? "docs-review__item is-current" : "docs-review__item"} data-revision-id={item.id} data-author-color={item.colorSlot}>
      <button type="button" className="docs-review__item-main" aria-current={current ? "true" : undefined} aria-label={label} onClick={() => controller.select(item.id)}>
        <span className="docs-review__item-head">
          <Badge tone={KIND_TONES[item.kind]}>{item.kindLabel}</Badge>
          <span className="docs-review__item-location">{item.location}</span>
        </span>
        <span className={`docs-review__item-text docs-review__item-text--${item.kind}`}>{item.summary}</span>
        <span className="docs-review__item-date">{formatReviewDate(item.date)}</span>
      </button>
      <span className="docs-review__item-actions">
        <button type="button" className="oui-icon-button docs-review__accept" aria-label={`Accept: ${label}`} title="Accept" disabled={busy} onClick={() => controller.accept(item.id)}>
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <path d="M3 8.5l3 3 7-7" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <button type="button" className="oui-icon-button docs-review__reject" aria-label={`Reject: ${label}`} title="Reject" disabled={busy} onClick={() => controller.reject(item.id)}>
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        </button>
      </span>
    </li>
  );
}

export interface RevisionListProps {
  groups: readonly AuthorGroup[];
  currentId: string | null;
  controller: ReviewController;
  busy?: boolean;
}

/** The shown revisions grouped by author, each group with its own accept-all and reject-all of the changes it shows. */
export function RevisionList({ groups, currentId, controller, busy = false }: RevisionListProps) {
  return (
    <div className="docs-review__groups">
      {groups.map((group) => {
        const headingId = `docs-review-author-${group.colorSlot}-${group.author.replace(/[^A-Za-z0-9]+/g, "-")}`;
        return (
          <section key={group.author} className="docs-review__group" aria-labelledby={headingId} data-author-color={group.colorSlot}>
            <header className="docs-review__group-head">
              <h3 id={headingId} className="docs-review__author">
                <span className="docs-review__swatch" aria-hidden="true" />
                {group.author}
              </h3>
              <span className="docs-review__counts">
                {group.items.length} {group.items.length === 1 ? "change" : "changes"}
                {group.formattingCount > 0 ? ` · ${group.formattingCount} formatting` : ""}
              </span>
              <span className="docs-review__group-actions">
                <button type="button" className="oui-button oui-button--ghost" disabled={busy} aria-label={`Accept all changes by ${group.author}`} onClick={() => controller.acceptByAuthor(group.author)}>
                  Accept all
                </button>
                <button type="button" className="oui-button oui-button--ghost" disabled={busy} aria-label={`Reject all changes by ${group.author}`} onClick={() => controller.rejectByAuthor(group.author)}>
                  Reject all
                </button>
              </span>
            </header>
            <ol className="docs-review__items">
              {group.items.map((item) => (
                <RevisionRow key={item.id} item={item} current={item.id === currentId} busy={busy} controller={controller} />
              ))}
            </ol>
          </section>
        );
      })}
    </div>
  );
}
