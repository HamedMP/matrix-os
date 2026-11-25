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
import { createGoogleCalendarProvider, readGoogleAccountAddress } from "./google-provider.js";
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

interface ConnectedRow {
  provider: CalendarProviderId;
  label: string;
  /** Empty when the host did not share a valid address. */
  email: string;
}

function connectedRow(row: MatrixOSConnectedService): ConnectedRow | undefined {
  const provider = PROVIDER_FOR_SERVICE.get(row.service);
  if (!provider || row.status !== "active") return undefined;
  const label = String(row.account_label ?? "").trim();
  if (!label) return undefined;
  const email = String(row.account_email ?? "").trim().toLowerCase();
  return { provider, label, email: isValidMailAddress(email) ? email : "" };
}

function toAccount({ provider, label }: ConnectedRow, address: string): ConnectedCalendarAccount {
  // An account whose address is unknown is told apart by its label, which the
  // host keeps unique per service; the label is never used as an address.
  const id = calendarAccountId(provider, address || `label:${label}`);
  return { account: { id, provider, address, displayName: label }, label };
}

/**
 * Active Google Calendar accounts, in the order the host lists them.
 *
 * A host that lists an account by its label only (the app capability route
 * does) gets its address from the account's primary calendar. When that cannot
 * be read the account keeps `address: ""`; its adapter then reads the owner's
 * address per event and refuses to answer an invitation it cannot attribute.
 */
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
  // Reading addresses stops once the host's request budget is used up.
  let canReadAddresses = true;
  for (const row of Array.isArray(rows) ? rows : []) {
    if (accounts.length >= MAX_CALENDAR_ACCOUNTS) break;
    const entry = connectedRow(row);
    if (!entry || (entry.email && seen.has(calendarAccountId(entry.provider, entry.email)))) continue;
    let address = entry.email;
    if (!address && canReadAddresses) {
      try {
        address = await readGoogleAccountAddress(bridge, entry.label) ?? "";
      } catch (error: unknown) {
        if (!(error instanceof ProviderError)) throw error;
        console.warn("[office-accounts] account address unavailable", error.code);
        if (error.code === "rate_limited") canReadAddresses = false;
      }
    }
    const connected = toAccount(entry, address);
    if (seen.has(connected.account.id)) continue;
    seen.add(connected.account.id);
    accounts.push(connected);
  }
  return accounts;
}

/** The adapter for one connected account. */
export function createCalendarProvider(connected: ConnectedCalendarAccount, bridge: CalendarServiceBridge = defaultCalendarBridge()): CalendarProvider {
  return createGoogleCalendarProvider({ account: connected.account, label: connected.label, bridge });
}
