/**
 * Start and end pickers with an all-day switch and a time zone. Changing the
 * start keeps the length; changing the zone keeps the wall-clock times.
 */
import { useMemo } from "react";
import { Checkbox, Select, TextField } from "../../../_shared/office-ui";
import { allDayDate, instantFromWallTime, instantToMs, type EventDraft } from "../../../_shared/office-accounts/types/calendar";
import { addDays, compareDayKeys, diffDays, isDayKey } from "../model/dates";
import { timeZoneOptions } from "./composerOptions";
import { formatZoneOffset, wallInputValue } from "./format";

export interface ComposerTimeProps {
  draft: EventDraft;
  /** The grid's zone, used for all-day drafts and as a picker default. */
  viewZone: string;
  disabled: boolean;
  onTimes(startWall: string, endWall: string, timeZone?: string): void;
  onAllDay(allDay: boolean): void;
  /** For all-day drafts: first and last (inclusive) day. */
  onAllDayDates(firstDay: string, lastDay: string): void;
}

const TIME = /^\d{2}:\d{2}$/;

function wallToMs(wall: string, zone: string): number | null {
  try {
    return instantToMs(instantFromWallTime(`${wall}:00`, zone));
  } catch (error: unknown) {
    if (error instanceof RangeError) return null;
    throw error;
  }
}

export function ComposerTime({ draft, viewZone, disabled, onTimes, onAllDay, onAllDayDates }: ComposerTimeProps) {
  const zone = draft.allDay ? viewZone : draft.timeZone;
  const zones = useMemo(() => timeZoneOptions([draft.timeZone, viewZone]), [draft.timeZone, viewZone]);
  const startWall = draft.allDay ? "" : wallInputValue(draft.start, zone);
  const endWall = draft.allDay ? "" : wallInputValue(draft.end, zone);
  const durationMs = instantToMs(draft.end) - instantToMs(draft.start);

  function changeStart(date: string, time: string) {
    if (!isDayKey(date) || !TIME.test(time)) return;
    const wall = `${date}T${time}`;
    const startMs = wallToMs(wall, zone);
    if (startMs === null) return;
    onTimes(wall, wallInputValue(startMs + Math.max(0, durationMs), zone));
  }

  function changeEnd(date: string, time: string) {
    if (!isDayKey(date) || !TIME.test(time)) return;
    onTimes(startWall, `${date}T${time}`);
  }

  if (draft.allDay) {
    const first = allDayDate(draft.start);
    const last = addDays(allDayDate(draft.end), -1);
    return (
      <fieldset className="cal-composer__group" disabled={disabled}>
        <legend className="oui-sr-only">When</legend>
        <div className="cal-composer__row">
          <TextField label="Starts" type="date" value={first} onChange={(value) => {
            if (!isDayKey(value)) return;
            onAllDayDates(value, addDays(value, Math.max(0, diffDays(first, last))));
          }} />
          <TextField label="Ends" type="date" value={last} onChange={(value) => {
            if (isDayKey(value)) onAllDayDates(first, compareDayKeys(value, first) < 0 ? first : value);
          }} />
        </div>
        <Checkbox label="All day" checked onChange={(checked) => onAllDay(checked)} />
      </fieldset>
    );
  }

  return (
    <fieldset className="cal-composer__group" disabled={disabled}>
      <legend className="oui-sr-only">When</legend>
      <div className="cal-composer__row">
        <TextField label="Start date" type="date" value={startWall.slice(0, 10)} onChange={(value) => changeStart(value, startWall.slice(11, 16))} />
        <TextField label="Start time" type="time" value={startWall.slice(11, 16)} onChange={(value) => changeStart(startWall.slice(0, 10), value)} />
      </div>
      <div className="cal-composer__row">
        <TextField label="End date" type="date" value={endWall.slice(0, 10)} onChange={(value) => changeEnd(value, endWall.slice(11, 16))} />
        <TextField label="End time" type="time" value={endWall.slice(11, 16)} onChange={(value) => changeEnd(endWall.slice(0, 10), value)} />
      </div>
      <Checkbox label="All day" checked={false} onChange={(checked) => onAllDay(checked)} />
      <Select
        label="Time zone"
        value={draft.timeZone}
        onChange={(value) => onTimes(startWall, endWall, value)}
        options={zones.map((value) => ({ value, label: `${value.replace(/_/g, " ")} (${formatZoneOffset(value, instantToMs(draft.start))})` }))}
      />
    </fieldset>
  );
}
