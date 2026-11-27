/**
 * Serial dates: the number a spreadsheet stores for a date and time.
 *
 * In the 1900 system day 1 is 1900-01-01 and day 60 is 1900-02-29, a day
 * that never existed; files depend on it, so it is kept: day 59 is
 * 1900-02-28, day 61 is 1900-03-01, and weekdays before March 1900 are one
 * day off the real calendar. In the 1904 system day 0 is 1904-01-01.
 * The fraction of a serial is the time of day.
 */

const MS_PER_DAY = 86_400_000;
const EPOCH_1900 = Date.UTC(1899, 11, 30);
const EPOCH_1904 = Date.UTC(1904, 0, 1);
/** 9999-12-31 in the 1900 system. */
export const MAX_SERIAL = 2_958_465;

export interface DateParts {
  year: number;
  /** 1 to 12. */
  month: number;
  /** 1 to 31; 0 for serial 0 of the 1900 system (`1900-01-00`). */
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
  /** 0 is Sunday. */
  weekday: number;
}

function utcDate(year: number, month: number, day: number): number {
  // Date.UTC maps years 0 to 99 to 1900 to 1999; setUTCFullYear does not, and it carries month and day overflow.
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  return date.getTime();
}

/**
 * Splits a serial into calendar parts. The time is rounded to `roundToMs`
 * milliseconds (1000 by default: whole seconds), carrying into the date.
 * Returns null for a negative serial or one past the year 9999.
 */
export function serialToParts(serial: number, date1904 = false, roundToMs = 1000): DateParts | null {
  if (!Number.isFinite(serial) || serial < 0 || serial >= MAX_SERIAL + 1) return null;
  let days = Math.floor(serial);
  let ms = Math.round(((serial - days) * MS_PER_DAY) / roundToMs) * roundToMs;
  if (ms >= MS_PER_DAY) {
    ms -= MS_PER_DAY;
    days++;
  }
  const hour = Math.floor(ms / 3_600_000);
  const minute = Math.floor((ms % 3_600_000) / 60_000);
  const second = Math.floor((ms % 60_000) / 1000);
  const millisecond = ms % 1000;
  const time = { hour, minute, second, millisecond };
  if (date1904) {
    const date = new Date(EPOCH_1904 + days * MS_PER_DAY);
    return {
      year: date.getUTCFullYear(),
      month: date.getUTCMonth() + 1,
      day: date.getUTCDate(),
      ...time,
      weekday: date.getUTCDay(),
    };
  }
  const weekday = (days + 6) % 7;
  if (days === 0) return { year: 1900, month: 1, day: 0, ...time, weekday };
  if (days === 60) return { year: 1900, month: 2, day: 29, ...time, weekday };
  const date = new Date(EPOCH_1900 + (days < 60 ? days + 1 : days) * MS_PER_DAY);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(), ...time, weekday };
}

/** The serial of a calendar date and time. Month and day may overflow, as in a DATE function. */
export function partsToSerial(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
  date1904 = false,
): number {
  const time = (hour * 3600 + minute * 60 + second) / 86_400;
  const utc = utcDate(year, month, day);
  if (date1904) return (utc - EPOCH_1904) / MS_PER_DAY + time;
  if (year === 1900 && month === 2 && day === 29) return 60 + time;
  const days = Math.round((utc - EPOCH_1900) / MS_PER_DAY);
  return (days < 61 ? days - 1 : days) + time;
}

function daysInMonth(year: number, month: number): number {
  return new Date(utcDate(year, month + 1, 0)).getUTCDate();
}

const ISO_PATTERN = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?)?(?:Z|[+-]00:?00)?$/;

/**
 * Converts `yyyy-mm-dd`, optionally followed by `T` or a space and
 * `hh:mm[:ss[.fff]]`, to a serial. Returns null for anything else, for a
 * date that is not on the calendar and for a date before the first serial.
 */
export function isoToSerial(text: string, date1904 = false): number | null {
  const match = ISO_PATTERN.exec(text);
  if (match === null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  const hour = match[4] === undefined ? 0 : Number(match[4]);
  const minute = match[5] === undefined ? 0 : Number(match[5]);
  const second = match[6] === undefined ? 0 : Number(match[6]);
  if (hour > 23 || minute > 59 || second > 59) return null;
  const fraction = match[7] === undefined ? 0 : Number(`0.${match[7]}`);
  const serial = partsToSerial(year, month, day, hour, minute, second + fraction, date1904);
  return serial < (date1904 ? 0 : 1) || serial >= MAX_SERIAL + 1 ? null : serial;
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

/** Writes a serial as `yyyy-mm-dd`, or `yyyy-mm-ddThh:mm:ss` when it has a time. Null when out of range. */
export function serialToIso(serial: number, date1904 = false): string | null {
  const parts = serialToParts(serial, date1904);
  if (parts === null) return null;
  const date = `${pad(parts.year, 4)}-${pad(parts.month, 2)}-${pad(parts.day, 2)}`;
  if (parts.hour === 0 && parts.minute === 0 && parts.second === 0) return date;
  return `${date}T${pad(parts.hour, 2)}:${pad(parts.minute, 2)}:${pad(parts.second, 2)}`;
}
