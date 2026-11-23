/**
 * One conversation in the list: checkbox, sender, subject, snippet, time and
 * the unread, flag and attachment indicators. All mailbox text renders as text.
 */
import { memo, type DragEvent, type MouseEvent } from "react";
import { Flag, Paperclip } from "lucide-react";
import type { ThreadSummary } from "../../../_shared/office-accounts/types/mail";
import type { ThreadKey } from "../model";
import { formatListTime, senderLabel } from "./format";

export const THREAD_ROW_HEIGHT = 72;

export interface ThreadRowProps {
  threadKey: ThreadKey;
  summary: ThreadSummary;
  index: number;
  selected: boolean;
  focused: boolean;
  open: boolean;
  pending: boolean;
  now: number;
  timeZone: string;
  ownAddresses: readonly string[];
  onRowClick: (key: ThreadKey, event: MouseEvent) => void;
  onCheck: (key: ThreadKey, shift: boolean) => void;
  onDragStart: (key: ThreadKey, event: DragEvent) => void;
  onDragEnd: () => void;
}

function ThreadRowView(props: ThreadRowProps) {
  const { threadKey: key, summary, index, selected, focused, open, pending, now, timeZone, ownAddresses } = props;
  const subject = summary.subject.trim() || "(no subject)";
  const time = formatListTime(summary.lastMessageAt, now, timeZone);
  const classes = [
    "mail-row",
    summary.unread && "is-unread",
    selected && "is-selected",
    focused && "is-focused",
    open && "is-open",
    pending && "is-pending",
  ].filter(Boolean).join(" ");
  return (
    <div
      role="row"
      id={`mail-row-${index}`}
      aria-selected={selected}
      aria-current={open ? "true" : undefined}
      aria-rowindex={index + 1}
      className={classes}
      style={{ top: index * THREAD_ROW_HEIGHT, height: THREAD_ROW_HEIGHT }}
      draggable
      data-thread-key={key}
      onClick={(event) => props.onRowClick(key, event)}
      onDragStart={(event) => props.onDragStart(key, event)}
      onDragEnd={props.onDragEnd}
    >
      <div role="gridcell" className="mail-row__check-cell">
        <input
          type="checkbox"
          className="oui-checkbox__input mail-row__check"
          checked={selected}
          aria-label={`Select ${subject}`}
          onClick={(event) => {
            event.stopPropagation();
            props.onCheck(key, event.shiftKey);
          }}
          onChange={() => undefined}
        />
      </div>
      <div role="gridcell" className="mail-row__body">
        <div className="mail-row__line">
          {summary.unread && <span className="mail-row__dot" aria-label="Unread" />}
          <span className="mail-row__sender">{senderLabel(summary.participants, ownAddresses)}</span>
          {summary.messageCount > 1 && <span className="mail-row__count">{summary.messageCount}</span>}
          <span className="mail-row__icons">
            {summary.hasAttachments && <Paperclip size={13} aria-label="Has attachments" />}
            {summary.flagged && <Flag size={13} className="mail-row__flag" aria-label="Flagged" />}
          </span>
          <time className="mail-row__time" dateTime={summary.lastMessageAt}>{time}</time>
        </div>
        <div className="mail-row__subject">{subject}</div>
        <div className="mail-row__snippet">{summary.snippet}</div>
      </div>
    </div>
  );
}

export const ThreadRow = memo(ThreadRowView);
