/**
 * The name an account is shown by. A host that was given no label for an
 * account labels it with the service id (`google_calendar`), which means
 * nothing to the owner; the account's address, else the provider's name,
 * stands in for it.
 */
import { CALENDAR_SERVICE_IDS, type CalendarAccount, type CalendarProviderId } from "../../../_shared/office-accounts/types/calendar";

export const PROVIDER_NAME: Readonly<Record<CalendarProviderId, string>> = { google: "Google Calendar" };

/** A service id, alone or with a number the host added to keep labels unique (`google_calendar_2`). */
function isServiceSlug(label: string): boolean {
  const lower = label.toLowerCase();
  return Object.values(CALENDAR_SERVICE_IDS).some((service) => lower === service || new RegExp(`^${service}[\\s_-]*\\d+$`).test(lower));
}

export function accountName(account: Pick<CalendarAccount, "provider" | "displayName" | "address">): string {
  const label = account.displayName.trim();
  if (label && !isServiceSlug(label)) return label;
  return account.address.trim() || PROVIDER_NAME[account.provider];
}
