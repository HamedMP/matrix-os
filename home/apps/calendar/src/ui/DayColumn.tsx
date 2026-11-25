/**
 * One day of the time grid: attendees' busy bands, proposals, laid-out
 * events, the drag preview, the keyboard cursor and the current-time line.
 */
import type { CSSProperties, KeyboardEvent, MouseEvent } from "react";
import { instantToMs, type CalendarInfo } from "../../../_shared/office-accounts/types/calendar";
import type { DaySlice } from "../model/dates";
import type { PositionedSegment } from "../model/layout";
import type { ProposalSegment } from "../model/proposals";
import type { BusyOverlay } from "../model/slots";
import { calendarColorStyle, personColorClass } from "./colors";
import { formatTime } from "./format";
import { PX_PER_MINUTE, segmentBox } from "./gridMath";

export interface GhostBlock {
  startMinute: number;
  endMinute: number;
  label: string;
}

export interface DayColumnProps {
  day: DaySlice;
  timeZone: string;
  segments: readonly PositionedSegment[];
  overlays: readonly BusyOverlay[];
  /** The assistant's attendee list, so each person keeps one colour. */
  attendees: readonly string[];
  proposals: readonly ProposalSegment[];
  calendarsById: Readonly<Record<string, CalendarInfo>>;
  pendingIds: ReadonlySet<string>;
  /** Event hidden while its drag preview is shown. */
  draggingId: string | null;
  ghost: GhostBlock | null;
  cursorMinute: number | null;
  /** Minute of the current-time line, or null when today is not this day. */
  nowMinute: number | null;
  onEventClick(eventId: string, anchor: HTMLElement): void;
  onEventKeyDown(segment: PositionedSegment, event: KeyboardEvent<HTMLButtonElement>): void;
  onProposal(proposalId: string): void;
}

function blockStyle(startMinute: number, endMinute: number) {
  return { top: startMinute * PX_PER_MINUTE, height: Math.max(4, (endMinute - startMinute) * PX_PER_MINUTE) };
}

function statusLabel(status: BusyOverlay["status"]): string {
  if (status === "tentative") return "tentative";
  if (status === "outOfOffice") return "out of office";
  if (status === "unknown") return "availability unknown";
  return "busy";
}

export function DayColumn(props: DayColumnProps) {
  const { day, timeZone, calendarsById } = props;

  const onEventButtonClick = (eventId: string) => (event: MouseEvent<HTMLButtonElement>) => {
    // Mouse presses are handled by the grid's pointer gestures; this path is keyboard activation.
    if (event.detail !== 0) return;
    props.onEventClick(eventId, event.currentTarget);
  };

  return (
    <div className="cal-day-column" data-day={day.key} role="group" aria-label={day.key}>
      {props.overlays.map((overlay) => {
        const index = Math.max(0, props.attendees.indexOf(overlay.address));
        return (
          <div
            key={`${overlay.address}-${overlay.startMinute}-${overlay.status}`}
            className={`cal-busy ${personColorClass(index)} cal-busy--${overlay.status}`}
            style={{ ...blockStyle(overlay.startMinute, overlay.endMinute), "--lane": index } as CSSProperties}
            title={`${overlay.address}: ${statusLabel(overlay.status)}`}
            aria-hidden="true"
          />
        );
      })}

      {props.proposals.map((segment) => (
        <button
          key={segment.proposal.id}
          type="button"
          className={`cal-proposal cal-proposal--${segment.proposal.source}`}
          style={blockStyle(segment.startMinute, segment.endMinute)}
          data-proposal-id={segment.proposal.id}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => props.onProposal(segment.proposal.id)}
          aria-label={`Suggested time ${formatTime(instantToMs(segment.proposal.start), timeZone)} to ${formatTime(instantToMs(segment.proposal.end), timeZone)}${segment.proposal.title ? `: ${segment.proposal.title}` : ""}`}
        >
          <span className="cal-proposal__label">{segment.proposal.source === "agent" ? "Proposed" : "Suggested"}</span>
          {segment.proposal.title && <span className="cal-proposal__title">{segment.proposal.title}</span>}
        </button>
      ))}

      {props.segments.map((segment) => {
        const box = segmentBox(segment);
        const { event } = segment;
        const calendar = calendarsById[event.calendarId];
        const pending = props.pendingIds.has(event.id);
        const classes = [
          "cal-event",
          pending && "is-pending",
          event.myResponse === "declined" && "is-declined",
          event.myResponse === "needsAction" && "is-unanswered",
          event.myResponse === "tentative" && "is-tentative",
          props.draggingId === event.id && "is-dragging",
        ].filter(Boolean).join(" ");
        const when = `${formatTime(instantToMs(event.start), timeZone)} – ${formatTime(instantToMs(event.end), timeZone)}`;
        return (
          <button
            key={event.id}
            type="button"
            className={classes}
            data-event-id={event.id}
            data-day-key={day.key}
            style={{ ...calendarColorStyle(calendar), top: box.top, height: box.height, left: `${box.left}%`, width: `${box.width}%` }}
            aria-label={`${event.title || "(No title)"}, ${when}${calendar ? `, ${calendar.name}` : ""}${pending ? ", saving" : ""}`}
            aria-busy={pending || undefined}
            onClick={onEventButtonClick(event.id)}
            onKeyDown={(keyEvent) => props.onEventKeyDown(segment, keyEvent)}
          >
            <span className="cal-event__title">{event.title || "(No title)"}</span>
            <span className="cal-event__time">{when}</span>
            {event.location && <span className="cal-event__location">{event.location}</span>}
            {!segment.continuesAfter && <span className="cal-event__resize" data-resize="true" aria-hidden="true" />}
          </button>
        );
      })}

      {props.ghost && (
        <div className="cal-ghost" style={blockStyle(props.ghost.startMinute, props.ghost.endMinute)} aria-hidden="true">
          {props.ghost.label}
        </div>
      )}
      {props.cursorMinute !== null && (
        <div className="cal-cursor" style={blockStyle(props.cursorMinute, props.cursorMinute + 30)} aria-hidden="true" />
      )}
      {props.nowMinute !== null && (
        <div className="cal-now" style={{ top: props.nowMinute * PX_PER_MINUTE }} data-testid="now-line" aria-hidden="true" />
      )}
    </div>
  );
}
