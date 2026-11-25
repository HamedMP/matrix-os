/**
 * Connected calendar accounts and a provider for each.
 *
 * Only the calendar services with an adapter here are listed; a connected
 * account of any other service is ignored.
 */
import type { MatrixOSBridge, MatrixOSConnectedService } from "../../matrix-os";
import { CALENDAR_SERVICE_IDS, ProviderError, calendarAccountId } from "../types/calendar.js";
import type { CalendarAccount, CalendarProvider, CalendarProviderId } from "../types/calendar.js";
import { isValidMailAddress } from "../types/addresses.js";
import { createGoogleCalendarProvider } from "./google-provider.js";
import { calendarBridgeFailure } from "./service.js";
import type { CalendarServiceBridge } from "./service.js";

export type CalendarAccountsBridge = Pick<MatrixOSBridge, "service" | "integrations">;

export interface ConnectedCalendarAccount {
  account: CalendarAccount;
  /** The integration account label to pass with every call for this account. */
  label: string;
}

const PROVIDER_FOR_SERVICE = new Map<string, CalendarProviderId>(
  Object.entries(CALENDAR_SERVICE_IDS).map(([provider, service]) => [service, provider as CalendarProviderId]),
);
/** More connected calendar accounts than this are ignored. */
export const MAX_CALENDAR_ACCOUNTS = 20;

/** `window.MatrixOS`, or `not_supported` when this host has no integrations bridge. */
export function defaultCalendarBridge(): CalendarAccountsBridge {
  const host = globalThis as { MatrixOS?: Partial<MatrixOSBridge>; window?: { MatrixOS?: Partial<MatrixOSBridge> } };
  const candidate = host.window?.MatrixOS ?? host.MatrixOS;
  if (!candidate || typeof candidate.service !== "function" || typeof candidate.integrations !== "function") {
    throw new ProviderError("not_supported", "Calendar accounts are not available here.");
  }
  return candidate as CalendarAccountsBridge;
}

function toAccount(row: MatrixOSConnectedService): ConnectedCalendarAccount | undefined {
  const provider = PROVIDER_FOR_SERVICE.get(row.service);
  if (!provider || row.status !== "active") return undefined;
  const label = String(row.account_label ?? "").trim();
  const email = String(row.account_email ?? "").trim().toLowerCase();
  const address = isValidMailAddress(email) ? email : label.toLowerCase();
  if (!label || !address) return undefined;
  return {
    account: { id: calendarAccountId(provider, address), provider, address, displayName: label },
    label,
  };
}

/** Active Google Calendar accounts, in the order the host lists them. */
export async function listCalendarAccounts(bridge: CalendarAccountsBridge = defaultCalendarBridge()): Promise<ConnectedCalendarAccount[]> {
  let rows: MatrixOSConnectedService[];
  try {
    rows = await bridge.integrations();
  } catch (error: unknown) {
    const failure = calendarBridgeFailure(error);
    console.warn("[office-accounts] integrations failed", failure.code);
    throw failure;
  }
  const seen = new Set<string>();
  const accounts: ConnectedCalendarAccount[] = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const entry = toAccount(row);
    if (!entry || seen.has(entry.account.id)) continue;
    seen.add(entry.account.id);
    accounts.push(entry);
    if (accounts.length >= MAX_CALENDAR_ACCOUNTS) break;
  }
  return accounts;
}

/** The adapter for one connected account. */
export function createCalendarProvider(connected: ConnectedCalendarAccount, bridge: CalendarServiceBridge = defaultCalendarBridge()): CalendarProvider {
  return createGoogleCalendarProvider({ account: connected.account, label: connected.label, bridge });
}
