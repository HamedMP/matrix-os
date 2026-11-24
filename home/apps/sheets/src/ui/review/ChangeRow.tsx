import { memo } from "react";
import { Badge, Checkbox } from "../../../../_shared/office-ui";
import type { ReviewItem } from "../../review";

export interface ChangeRowProps {
  item: ReviewItem;
  current: boolean;
  selected: boolean;
  onSelect: (id: string, on: boolean) => void;
  onGoTo: (id: string) => void;
  onAccept: (id: string) => void;
  onReject: (id: string) => void;
}

function Value({ display, formula, tone }: { display: string; formula: string | null; tone: "old" | "new" }) {
  const Tag = tone === "old" ? "del" : "ins";
  return (
    <Tag className={`sheets-review__value sheets-review__value--${tone}`}>
      <span>{display === "" ? "empty" : display}</span>
      {formula !== null && <code className="sheets-review__formula">={formula}</code>}
    </Tag>
  );
}

/** One pending change: where it is, what it was and what it is now, with its own accept and reject. */
export const ChangeRow = memo(function ChangeRow({ item, current, selected, onSelect, onGoTo, onAccept, onReject }: ChangeRowProps) {
  const isCell = item.kind === "cell";
  return (
    <li className={`sheets-review__item${current ? " is-current" : ""}`} aria-current={current ? "true" : undefined} data-change-id={item.id}>
      <Checkbox label={`Select change at ${item.location}`} checked={selected} onChange={(on) => onSelect(item.id, on)} className="sheets-review__check" />
      <button type="button" className="sheets-review__go" onClick={() => onGoTo(item.id)} aria-label={`Go to ${item.location}`}>
        <span className="sheets-review__where">
          <span className="sheets-review__sheet">{item.sheetName}</span>
          {item.address !== "" && <span className="sheets-review__address">{item.address}</span>}
          {item.stale && <Badge tone="warning">Edited since</Badge>}
          {item.formatOnly && <Badge tone="neutral">Format</Badge>}
        </span>
        {isCell && !item.formatOnly ? (
          <span className="sheets-review__values">
            <Value display={item.oldDisplay} formula={item.oldFormula} tone="old" />
            <span aria-hidden="true" className="sheets-review__arrow">→</span>
            <Value display={item.newDisplay} formula={item.newFormula} tone="new" />
          </span>
        ) : (
          <span className="sheets-review__summary">{item.summary}</span>
        )}
      </button>
      <span className="sheets-review__item-actions">
        <button type="button" className="oui-button oui-button--success" onClick={() => onAccept(item.id)} aria-label={`Accept change at ${item.location}`}>
          Accept
        </button>
        <button type="button" className="oui-button oui-button--danger" onClick={() => onReject(item.id)} aria-label={`Reject change at ${item.location}`}>
          Reject
        </button>
      </span>
    </li>
  );
});
