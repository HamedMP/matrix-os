/**
 * Guest entry: type or paste addresses, Enter, comma or Tab adds them.
 * Each guest shows the colour their busy time has on the grid.
 */
import { useState, type KeyboardEvent } from "react";
import { X } from "lucide-react";
import { TextField } from "../../../_shared/office-ui";
import { MAX_EVENT_ATTENDEES, type EventDraftAttendee } from "../../../_shared/office-accounts/types/calendar";
import { personColorClass } from "./colors";
import { parseAddressInput } from "./composer-helpers";

export interface AttendeeFieldProps {
  attendees: readonly EventDraftAttendee[];
  /** The assistant's attendee order, so chips match the overlay colours. */
  colorOrder: readonly string[];
  disabled?: boolean;
  onAdd(attendee: EventDraftAttendee): void;
  onRemove(address: string): void;
  onToggleOptional(address: string, optional: boolean): void;
}

export function AttendeeField({ attendees, colorOrder, disabled, onAdd, onRemove, onToggleOptional }: AttendeeFieldProps) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const full = attendees.length >= MAX_EVENT_ATTENDEES;

  function commit(): boolean {
    const { valid, invalid } = parseAddressInput(text);
    if (valid.length === 0 && invalid.length === 0) return false;
    for (const address of valid) onAdd({ address });
    setText(invalid.join(", "));
    setError(invalid.length > 0 ? "Enter a valid email address." : null);
    return true;
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) {
    if (event.key === "Enter" || event.key === "," || event.key === ";" || (event.key === "Tab" && text.trim())) {
      if (commit() || event.key !== "Tab") event.preventDefault();
    } else if (event.key === "Backspace" && !text && attendees.length > 0) {
      onRemove(attendees[attendees.length - 1].address);
    }
  }

  return (
    <div className="cal-attendees">
      <TextField
        label="Guests"
        type="email"
        value={text}
        placeholder="Add people by email"
        onChange={(value) => {
          setText(value);
          if (error) setError(null);
        }}
        error={error}
        disabled={disabled || full}
        hint={full ? `At most ${MAX_EVENT_ATTENDEES} guests.` : undefined}
        inputProps={{ onKeyDown, onBlur: () => void commit(), autoComplete: "off", multiple: true }}
      />
      {attendees.length > 0 && (
        <ul className="cal-attendees__list" aria-label="Guest list">
          {attendees.map((attendee) => {
            const index = colorOrder.indexOf(attendee.address.toLowerCase());
            return (
              <li key={attendee.address} className={`cal-attendee ${index >= 0 ? personColorClass(index) : ""}`}>
                <span className="cal-attendee__dot" aria-hidden="true" />
                <span className="cal-attendee__address">{attendee.name ? `${attendee.name} <${attendee.address}>` : attendee.address}</span>
                <button
                  type="button"
                  className="oui-chip cal-attendee__optional"
                  aria-pressed={attendee.optional === true}
                  onClick={() => onToggleOptional(attendee.address, attendee.optional !== true)}
                  disabled={disabled}
                >
                  Optional
                </button>
                <button type="button" className="oui-icon-button" aria-label={`Remove ${attendee.address}`} onClick={() => onRemove(attendee.address)} disabled={disabled}>
                  <X size={14} />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
