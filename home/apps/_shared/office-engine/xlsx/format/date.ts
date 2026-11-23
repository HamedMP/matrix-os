/** Date and time sections of a format code. */

import type { FormatSection, FormatToken } from "./sections.js";
import { serialToParts } from "./serial.js";

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

/** Text shown for a serial that is not a date (negative, or past the year 9999). */
export const INVALID_DATE_TEXT = "#####";

export function renderDateSection(section: FormatSection, serial: number, date1904: boolean): string {
  let subsecDigits = 0;
  let twelveHour = false;
  for (const token of section.tokens) {
    if (token.t === "subsec") subsecDigits = Math.max(subsecDigits, token.digits);
    if (token.t === "ampm") twelveHour = true;
  }
  const roundToMs = 10 ** (3 - subsecDigits);
  const parts = serialToParts(serial, date1904, roundToMs);
  if (parts === null) return INVALID_DATE_TEXT;
  // Elapsed time counts from serial 0, rounded the same way as the clock parts.
  const totalMs = Math.round((serial * 86_400_000) / roundToMs) * roundToMs;
  let out = "";
  for (const token of section.tokens as readonly FormatToken[]) {
    switch (token.t) {
      case "lit":
        out += token.v;
        break;
      case "date":
        if (token.unit === "y") out += token.width <= 2 ? pad(parts.year % 100, 2) : pad(parts.year, 4);
        else if (token.unit === "m") {
          const name = MONTHS[parts.month - 1] as string;
          if (token.width === 1) out += String(parts.month);
          else if (token.width === 2) out += pad(parts.month, 2);
          else if (token.width === 3) out += name.slice(0, 3);
          else if (token.width === 5) out += name.charAt(0);
          else out += name;
        } else if (token.unit === "d") {
          const name = WEEKDAYS[parts.weekday] as string;
          if (token.width === 1) out += String(parts.day);
          else if (token.width === 2) out += pad(parts.day, 2);
          else if (token.width === 3) out += name.slice(0, 3);
          else out += name;
        } else if (token.unit === "h") {
          const hour = twelveHour ? parts.hour % 12 || 12 : parts.hour;
          out += token.width === 1 ? String(hour) : pad(hour, 2);
        } else if (token.unit === "n") {
          out += token.width === 1 ? String(parts.minute) : pad(parts.minute, 2);
        } else {
          out += token.width === 1 ? String(parts.second) : pad(parts.second, 2);
        }
        break;
      case "ampm":
        if (token.short) out += parts.hour < 12 ? "A" : "P";
        else out += parts.hour < 12 ? "AM" : "PM";
        break;
      case "elapsed": {
        const unitMs = token.unit === "h" ? 3_600_000 : token.unit === "m" ? 60_000 : 1000;
        out += pad(Math.floor(totalMs / unitMs), token.width);
        break;
      }
      case "subsec":
        out += `.${pad(parts.millisecond, 3).slice(0, token.digits)}`;
        break;
      default:
        break;
    }
  }
  return out;
}
