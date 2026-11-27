import type { ReactNode } from "react";
import { cx } from "./internal";

export interface ReviewBarProps {
  /** Number of pending changes. */
  total: number;
  /** Zero-based index of the current change, or -1 when none is current. */
  index: number;
  onPrevious: () => void;
  onNext: () => void;
  onAccept: () => void;
  onReject: () => void;
  onAcceptAll: () => void;
  onRejectAll: () => void;
  /** Singular noun used in labels, e.g. "revision" or "cell change" (default "change"). */
  noun?: string;
  /** Optional description of the current change (author, kind). */
  detail?: ReactNode;
  busy?: boolean;
  className?: string;
}

const Arrow = ({ up }: { up: boolean }) => (
  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
    <path d={up ? "M4 10l4-4 4 4" : "M4 6l4 4 4-4"} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/** Review controls for tracked changes: navigate, accept, reject, and bulk actions. */
export function ReviewBar({
  total,
  index,
  onPrevious,
  onNext,
  onAccept,
  onReject,
  onAcceptAll,
  onRejectAll,
  noun = "change",
  detail,
  busy = false,
  className,
}: ReviewBarProps) {
  const empty = total <= 0;
  const hasCurrent = !empty && index >= 0 && index < total;
  const plural = noun.endsWith("s") ? noun : `${noun}s`;
  const counter = empty ? `No ${plural}` : hasCurrent ? `${index + 1} of ${total}` : `${total} ${total === 1 ? noun : plural}`;

  return (
    <div role="toolbar" aria-label={`Review ${plural}`} className={cx("oui-review", className)}>
      <div className="oui-review__nav">
        <button type="button" className="oui-icon-button" aria-label={`Previous ${noun}`} title={`Previous ${noun}`} disabled={busy || empty || (hasCurrent && index === 0)} onClick={onPrevious}>
          <Arrow up />
        </button>
        <span className="oui-review__counter" aria-live="polite">{counter}</span>
        <button type="button" className="oui-icon-button" aria-label={`Next ${noun}`} title={`Next ${noun}`} disabled={busy || empty || (hasCurrent && index >= total - 1)} onClick={onNext}>
          <Arrow up={false} />
        </button>
      </div>
      {detail && <span className="oui-review__detail">{detail}</span>}
      <div className="oui-review__actions">
        <button type="button" className="oui-button oui-button--success" aria-label={`Accept ${noun}`} disabled={busy || !hasCurrent} onClick={onAccept}>Accept</button>
        <button type="button" className="oui-button oui-button--danger" aria-label={`Reject ${noun}`} disabled={busy || !hasCurrent} onClick={onReject}>Reject</button>
        <span className="oui-review__divider" aria-hidden="true" />
        <button type="button" className="oui-button oui-button--ghost" disabled={busy || empty} onClick={onAcceptAll}>Accept all</button>
        <button type="button" className="oui-button oui-button--ghost" disabled={busy || empty} onClick={onRejectAll}>Reject all</button>
      </div>
    </div>
  );
}
