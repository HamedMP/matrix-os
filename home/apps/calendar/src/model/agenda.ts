/**
 * The agenda view: events grouped under each day they touch.
 */
import { instantToMs, type CalendarEvent } from "../../../_shared/office-accounts/types/calendar";
import { compareDayKeys, diffDays, type DayKey } from "./dates";
import { eventDaySpan, isMultiDayBar } from "./layout";

export interface AgendaItem {
  event: CalendarEvent;
  /** Shown as a whole-day line (all-day, or a day or longer). */
  wholeDay: boolean;
  continuesBefore: boolean;
  continuesAfter: boolean;
}

export interface AgendaDay {
  key: DayKey;
  items: AgendaItem[];
}

function compareItems(a: AgendaItem, b: AgendaItem): number {
  return Number(b.wholeDay) - Number(a.wholeDay)
    || instantToMs(a.event.start) - instantToMs(b.event.start)
    || instantToMs(a.event.end) - instantToMs(b.event.end)
    || a.event.title.localeCompare(b.event.title)
    || a.event.id.localeCompare(b.event.id);
}

/**
 * One group per day in `dayKeys` that has events (or every day with
 * `includeEmptyDays`). An event that spans days appears under each of them.
 */
export function groupAgenda(
  events: readonly CalendarEvent[],
  dayKeys: readonly DayKey[],
  timeZone: string,
  options: { includeEmptyDays?: boolean } = {},
): AgendaDay[] {
  const groups: AgendaDay[] = dayKeys.map((key) => ({ key, items: [] }));
  for (const event of events) {
    const { startKey, endKey } = eventDaySpan(event, timeZone);
    const wholeDay = isMultiDayBar(event);
    for (const group of groups) {
      if (compareDayKeys(group.key, startKey) < 0 || compareDayKeys(group.key, endKey) >= 0) continue;
      group.items.push({
        event,
        wholeDay,
        continuesBefore: group.key !== startKey,
        continuesAfter: diffDays(group.key, endKey) > 1,
      });
    }
  }
  for (const group of groups) group.items.sort(compareItems);
  return options.includeEmptyDays ? groups : groups.filter((group) => group.items.length > 0);
}
