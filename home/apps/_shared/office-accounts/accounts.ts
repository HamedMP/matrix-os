/**
 * Connected-account discovery for the Mail and Calendar apps.
 *
 * `listConnected` is generic: it returns the connected accounts of the given
 * integration services that this app may use. `listMailAccounts` turns the mail
 * services into `MailAccount`s, learning each mailbox address when the
 * integration row does not carry one.
 *
 * Every failure is a `ProviderError`; bridge and provider text never reaches
 * the caller.
 */
import { bridgeFailure, createServiceCaller, defaultBridge, asArray, asRecord, asString, type ServiceBridge } from "./mail/bridge.js";
import { mapLimit } from "./mail/support.js";
import {
  MAIL_SERVICE_IDS, ProviderError, isValidMailAddress, mailAccountId, normalizeMailAddress, toProviderError,
  type MailAccount, type MailProviderId,
} from "./types/mail.js";

export interface ConnectedAccount {
  /** Integration service id, for example `gmail` or `google_calendar`. */
  service: string;
  /** The account label; pass it as the `label` of every `MatrixOS.service` call for this account. */
  label: string;
  /** The account address when the platform knows it, lower-cased; otherwise null. */
  email: string | null;
}

/** A mail account plus the integration label its adapter must use. */
export interface ConnectedMailAccount extends MailAccount {
  label: string;
}

/** Upper bound on accounts read from the inventory. */
export const MAX_CONNECTED_ACCOUNTS = 50;
const MAX_LABEL_CHARS = 256;
const PROFILE_PARALLEL = 3;

function asEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return isValidMailAddress(trimmed) ? normalizeMailAddress(trimmed) : null;
}

/**
 * Connected accounts of `serviceIds`, in inventory order, without repeats.
 * Rejects with `not_supported` when this host offers no integrations to the app.
 */
export async function listConnected(serviceIds: readonly string[], bridge: ServiceBridge = defaultBridge()): Promise<ConnectedAccount[]> {
  let rows: unknown;
  try {
    const capabilities = await bridge.capabilities();
    if (!capabilities || capabilities.integrations !== true) {
      throw new ProviderError("not_supported", "Connected accounts are not available here.");
    }
    rows = await bridge.integrations();
  } catch (error: unknown) {
    const failure = bridgeFailure(error);
    console.warn("[office-accounts] account inventory failed", failure.code);
    throw failure;
  }
  const wanted = new Set(serviceIds);
  const seen = new Set<string>();
  const out: ConnectedAccount[] = [];
  for (const row of asArray(rows).map(asRecord)) {
    const service = asString(row.service);
    const label = asString(row.account_label);
    const status = asString(row.status);
    if (!wanted.has(service) || !label || label.length > MAX_LABEL_CHARS) continue;
    if (status && status !== "active") continue;
    const key = `${service}\u0000${label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ service, label, email: asEmail(row.account_email) ?? asEmail(label) });
    if (out.length >= MAX_CONNECTED_ACCOUNTS) break;
  }
  return out;
}

function providerOf(service: string): MailProviderId | null {
  for (const [provider, id] of Object.entries(MAIL_SERVICE_IDS) as Array<[MailProviderId, string]>) {
    if (id === service) return provider;
  }
  return null;
}

/** Asks the provider for the mailbox address. Null when it cannot be learnt. */
async function lookUpAddress(bridge: ServiceBridge, provider: MailProviderId, account: ConnectedAccount): Promise<string | null> {
  const caller = createServiceCaller(bridge, account.service, account.label);
  if (provider === "gmail") {
    return asEmail(asRecord(await caller.read("get_profile")).emailAddress);
  }
  // Outlook has no profile action among the mail actions; the newest sent message names the owner.
  const sent = asRecord(await caller.read("list_folder_messages", { folderId: "sentitems", top: 1 }));
  return asEmail(asRecord(asRecord(asRecord(asArray(sent.value)[0]).from).emailAddress).address);
}

/**
 * Every connected Gmail and Outlook mailbox. An account whose address cannot
 * be learnt is still listed, under its label; one that disappeared while
 * listing (`not_connected`) is left out.
 */
export async function listMailAccounts(bridge: ServiceBridge = defaultBridge()): Promise<ConnectedMailAccount[]> {
  const connected = await listConnected(Object.values(MAIL_SERVICE_IDS), bridge);
  const resolved = await mapLimit(connected, PROFILE_PARALLEL, async (account): Promise<ConnectedMailAccount | null> => {
    const provider = providerOf(account.service);
    if (!provider) return null;
    let address = account.email;
    if (!address) {
      try {
        address = await lookUpAddress(bridge, provider, account);
      } catch (error: unknown) {
        const failure = toProviderError(error);
        if (failure.code === "not_connected") return null;
        console.warn("[office-accounts] mailbox address unavailable", failure.code);
      }
    }
    const mailbox = address ?? normalizeMailAddress(account.label);
    return { id: mailAccountId(provider, mailbox), provider, address: mailbox, displayName: account.label.trim() || mailbox, label: account.label };
  });
  const seen = new Set<string>();
  return resolved.filter((account): account is ConnectedMailAccount => {
    if (!account || seen.has(account.id)) return false;
    seen.add(account.id);
    return true;
  });
}
