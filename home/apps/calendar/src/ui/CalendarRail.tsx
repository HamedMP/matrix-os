/**
 * Left rail: the month navigator and each account's calendars with a colour
 * swatch and a show or hide checkbox.
 */
import { Checkbox, Skeleton } from "../../../_shared/office-ui";
import type { CalendarAccount, CalendarInfo } from "../../../_shared/office-accounts/types/calendar";
import type { CalendarState } from "../model";
import type { DayKey } from "../model/dates";
import { PROVIDER_NAME, accountName } from "./account-name";
import { calendarColorStyle } from "./colors";
import { MiniMonth } from "./MiniMonth";

export interface CalendarRailProps {
  state: CalendarState;
  onPickDay(day: DayKey): void;
  onToggle(calendarId: string, visible: boolean): void;
}

const PROVIDER_LABEL: Record<CalendarAccount["provider"], string> = { google: "Google" };

export function CalendarRail({ state, onPickDay, onToggle }: CalendarRailProps) {
  const byAccount = state.accounts.map((account) => ({
    account,
    name: accountName(account),
    calendars: state.calendars.filter((calendar) => calendar.accountId === account.id),
  }));
  return (
    <div className="cal-rail">
      <MiniMonth
        anchor={state.range.anchor}
        today={state.today}
        weekStart={state.preferences.weekStart}
        rangeStart={state.range.startKey}
        rangeEnd={state.range.endKey}
        onPick={onPickDay}
      />
      {state.accountsStatus === "loading" && state.accounts.length === 0 && (
        <div className="cal-rail__loading"><Skeleton lines={4} /></div>
      )}
      {byAccount.map(({ account, name, calendars }) => (
        <section key={account.id} className="cal-rail__account" aria-label={`${name} calendars`}>
          <h2 className="cal-rail__account-name">
            <span>{name}</span>
            {name !== PROVIDER_NAME[account.provider] && <span className="cal-rail__provider">{PROVIDER_LABEL[account.provider]}</span>}
          </h2>
          {calendars.length === 0 && <p className="cal-rail__none">No calendars</p>}
          <ul className="cal-rail__list">
            {calendars.map((calendar: CalendarInfo) => (
              <li key={calendar.id} className="cal-rail__calendar" style={calendarColorStyle(calendar)}>
                <span className={`cal-swatch${calendar.visible ? "" : " is-hidden"}`} aria-hidden="true" />
                <Checkbox
                  label={calendar.name}
                  checked={calendar.visible}
                  onChange={(checked) => onToggle(calendar.id, checked)}
                  description={calendar.writable ? undefined : "Read-only"}
                />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
