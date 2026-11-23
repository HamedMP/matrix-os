/**
 * Details of one event: time, place, calendar, attendees and their answers,
 * the join link, and the owner's own answer buttons. All event text is
 * untrusted and rendered as plain text.
 */
import type { RefObject } from "react";
import { MapPin, Pencil, Repeat, Trash2, Video } from "lucide-react";
import { Avatar, Badge, Popover } from "../../../_shared/office-ui";
import type { AttendeeResponse, CalendarEvent, CalendarInfo, EventResponse } from "../../../_shared/office-accounts/types/calendar";
import { calendarColorStyle } from "./colors";
import { safeJoinUrl } from "./eventActions";
import { formatEventWhen } from "./format";

export interface EventPopoverProps {
  event: CalendarEvent;
  calendar: CalendarInfo | undefined;
  timeZone: string;
  anchorRef: RefObject<HTMLElement | null>;
  editable: boolean;
  pending: boolean;
  onClose(): void;
  onEdit(): void;
  onDelete(): void;
  onRespond(response: EventResponse): void;
}

const RESPONSE_TEXT: Record<AttendeeResponse, string> = {
  accepted: "Accepted",
  declined: "Declined",
  tentative: "Maybe",
  needsAction: "Awaiting reply",
};
const RESPONSE_TONE: Record<AttendeeResponse, "success" | "danger" | "warning" | "neutral"> = {
  accepted: "success",
  declined: "danger",
  tentative: "warning",
  needsAction: "neutral",
};
const ANSWERS: ReadonlyArray<{ response: EventResponse; label: string }> = [
  { response: "accepted", label: "Accept" },
  { response: "tentative", label: "Maybe" },
  { response: "declined", label: "Decline" },
];

export function EventPopover(props: EventPopoverProps) {
  const { event, calendar } = props;
  const joinUrl = safeJoinUrl(event.onlineMeeting?.joinUrl);
  const title = event.title || "(No title)";
  return (
    <Popover open onClose={props.onClose} anchorRef={props.anchorRef} label={title} className="cal-popover">
      <div className="cal-popover__body" style={calendarColorStyle(calendar)}>
        <div className="cal-popover__head">
          <span className="cal-swatch" aria-hidden="true" />
          <h2 className="cal-popover__title">{title}</h2>
          <div className="cal-popover__tools">
            {props.editable && (
              <>
                <button type="button" className="oui-icon-button" aria-label="Edit event" onClick={props.onEdit}><Pencil size={16} /></button>
                <button type="button" className="oui-icon-button" aria-label="Delete event" onClick={props.onDelete}><Trash2 size={16} /></button>
              </>
            )}
          </div>
        </div>
        <p className="cal-popover__when">{formatEventWhen(event, props.timeZone)}</p>
        {event.recurrenceText && <p className="cal-popover__line"><Repeat size={14} aria-hidden="true" /> {event.recurrenceText}</p>}
        {event.location && <p className="cal-popover__line"><MapPin size={14} aria-hidden="true" /> {event.location}</p>}
        {calendar && <p className="cal-popover__calendar">{calendar.name}{calendar.writable ? "" : " (read-only)"}</p>}
        {props.pending && <p className="cal-popover__pending" role="status">Saving…</p>}
        {joinUrl && (
          <a className="oui-button oui-button--primary cal-popover__join" href={joinUrl} target="_blank" rel="noopener noreferrer">
            <Video size={16} aria-hidden="true" /> Join meeting
          </a>
        )}
        {event.descriptionText && <p className="cal-popover__description">{event.descriptionText}</p>}
        {event.attendees.length > 0 && (
          <section className="cal-popover__attendees" aria-label="Guests">
            <h3>{event.attendees.length} {event.attendees.length === 1 ? "guest" : "guests"}</h3>
            <ul>
              {event.attendees.map((attendee) => (
                <li key={attendee.address}>
                  <Avatar name={attendee.name || attendee.address} size={24} />
                  <span className="cal-popover__person">
                    <span>{attendee.name || attendee.address}</span>
                    {attendee.organizer && <span className="cal-popover__role">Organizer</span>}
                    {attendee.optional && <span className="cal-popover__role">Optional</span>}
                  </span>
                  <Badge tone={RESPONSE_TONE[attendee.response]}>{RESPONSE_TEXT[attendee.response]}</Badge>
                </li>
              ))}
            </ul>
          </section>
        )}
        {event.myResponse !== null && (
          <div className="cal-popover__rsvp" role="group" aria-label="Your answer">
            <span>Going?</span>
            {ANSWERS.map((answer) => (
              <button
                key={answer.response}
                type="button"
                className={`oui-chip${event.myResponse === answer.response ? " is-selected" : ""}`}
                aria-pressed={event.myResponse === answer.response}
                disabled={props.pending}
                onClick={() => props.onRespond(answer.response)}
              >
                {answer.label}
              </button>
            ))}
          </div>
        )}
      </div>
    </Popover>
  );
}
