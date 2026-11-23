/**
 * Outlook reports zones by Windows name ("W. Europe Standard Time"). The
 * contract uses IANA names, so the common Windows names are mapped here (from
 * the CLDR primary zone for each). An IANA name passes through; anything
 * unknown becomes `UTC`.
 */
import { TIME_ZONE_NAME } from "./common.js";

const WINDOWS_TO_IANA: Readonly<Record<string, string>> = {
  "UTC": "UTC",
  "Coordinated Universal Time": "UTC",
  "Dateline Standard Time": "Etc/GMT+12",
  "Hawaiian Standard Time": "Pacific/Honolulu",
  "Alaskan Standard Time": "America/Anchorage",
  "Pacific Standard Time": "America/Los_Angeles",
  "Pacific Standard Time (Mexico)": "America/Tijuana",
  "US Mountain Standard Time": "America/Phoenix",
  "Mountain Standard Time": "America/Denver",
  "Central America Standard Time": "America/Guatemala",
  "Central Standard Time": "America/Chicago",
  "Central Standard Time (Mexico)": "America/Mexico_City",
  "Canada Central Standard Time": "America/Regina",
  "SA Pacific Standard Time": "America/Bogota",
  "Eastern Standard Time": "America/New_York",
  "US Eastern Standard Time": "America/Indianapolis",
  "Atlantic Standard Time": "America/Halifax",
  "Venezuela Standard Time": "America/Caracas",
  "SA Western Standard Time": "America/La_Paz",
  "Pacific SA Standard Time": "America/Santiago",
  "Newfoundland Standard Time": "America/St_Johns",
  "E. South America Standard Time": "America/Sao_Paulo",
  "Argentina Standard Time": "America/Buenos_Aires",
  "Greenland Standard Time": "America/Godthab",
  "Azores Standard Time": "Atlantic/Azores",
  "GMT Standard Time": "Europe/London",
  "Greenwich Standard Time": "Atlantic/Reykjavik",
  "W. Europe Standard Time": "Europe/Berlin",
  "Central Europe Standard Time": "Europe/Budapest",
  "Romance Standard Time": "Europe/Paris",
  "Central European Standard Time": "Europe/Warsaw",
  "W. Central Africa Standard Time": "Africa/Lagos",
  "GTB Standard Time": "Europe/Bucharest",
  "E. Europe Standard Time": "Europe/Chisinau",
  "FLE Standard Time": "Europe/Kiev",
  "Israel Standard Time": "Asia/Jerusalem",
  "Egypt Standard Time": "Africa/Cairo",
  "South Africa Standard Time": "Africa/Johannesburg",
  "Turkey Standard Time": "Europe/Istanbul",
  "Arabic Standard Time": "Asia/Baghdad",
  "Arab Standard Time": "Asia/Riyadh",
  "Russian Standard Time": "Europe/Moscow",
  "E. Africa Standard Time": "Africa/Nairobi",
  "Iran Standard Time": "Asia/Tehran",
  "Arabian Standard Time": "Asia/Dubai",
  "Afghanistan Standard Time": "Asia/Kabul",
  "Pakistan Standard Time": "Asia/Karachi",
  "West Asia Standard Time": "Asia/Tashkent",
  "India Standard Time": "Asia/Calcutta",
  "Sri Lanka Standard Time": "Asia/Colombo",
  "Nepal Standard Time": "Asia/Katmandu",
  "Bangladesh Standard Time": "Asia/Dhaka",
  "Myanmar Standard Time": "Asia/Rangoon",
  "SE Asia Standard Time": "Asia/Bangkok",
  "China Standard Time": "Asia/Shanghai",
  "Singapore Standard Time": "Asia/Singapore",
  "Taipei Standard Time": "Asia/Taipei",
  "W. Australia Standard Time": "Australia/Perth",
  "Korea Standard Time": "Asia/Seoul",
  "Tokyo Standard Time": "Asia/Tokyo",
  "Cen. Australia Standard Time": "Australia/Adelaide",
  "AUS Central Standard Time": "Australia/Darwin",
  "E. Australia Standard Time": "Australia/Brisbane",
  "AUS Eastern Standard Time": "Australia/Sydney",
  "Tasmania Standard Time": "Australia/Hobart",
  "West Pacific Standard Time": "Pacific/Port_Moresby",
  "New Zealand Standard Time": "Pacific/Auckland",
  "Fiji Standard Time": "Pacific/Fiji",
  "Tonga Standard Time": "Pacific/Tongatapu",
  "Samoa Standard Time": "Pacific/Apia",
  "Line Islands Standard Time": "Pacific/Kiritimati",
};

/** The IANA name for a Windows or IANA zone name; `UTC` when it is unknown. */
export function ianaZone(name: unknown): string {
  if (typeof name !== "string") return "UTC";
  const trimmed = name.trim();
  const mapped = WINDOWS_TO_IANA[trimmed];
  if (mapped) return mapped;
  if (trimmed.includes("/") && TIME_ZONE_NAME.test(trimmed) && isKnownZone(trimmed)) return trimmed;
  return "UTC";
}

function isKnownZone(name: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: name });
    return true;
  } catch (error: unknown) {
    // An unknown zone name is a RangeError; anything else is a real fault.
    if (!(error instanceof RangeError)) throw error;
    return false;
  }
}
