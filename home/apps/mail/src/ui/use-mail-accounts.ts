/**
 * Finds the connected Gmail and Outlook accounts and builds one provider per
 * account. The status drives the onboarding, loading and error states.
 */
import { useCallback, useEffect, useState } from "react";
import { listMailAccounts } from "../../../_shared/office-accounts/accounts";
import { createMailProvider } from "../../../_shared/office-accounts/mail";
import { toProviderError } from "../../../_shared/office-accounts/types/mail";
import type { MailAccountEntry } from "../model";

export type AccountsStatus =
  | { kind: "loading" }
  | { kind: "ready"; entries: MailAccountEntry[] }
  /** Integrations work, but no mailbox is connected. */
  | { kind: "empty" }
  /** This host offers no integrations to the app. */
  | { kind: "unavailable" }
  | { kind: "error" };

export type AccountsLoader = () => Promise<MailAccountEntry[]>;

/** The default loader: every connected mailbox with its adapter. */
export const loadConnectedMailAccounts: AccountsLoader = async () => {
  const accounts = await listMailAccounts();
  return accounts.map((account) => ({ account, provider: createMailProvider(account) }));
};

export async function resolveAccountsStatus(loader: AccountsLoader): Promise<AccountsStatus> {
  try {
    const entries = await loader();
    return entries.length > 0 ? { kind: "ready", entries } : { kind: "empty" };
  } catch (error: unknown) {
    const failure = toProviderError(error);
    if (failure.code === "not_supported") return { kind: "unavailable" };
    if (failure.code === "not_connected") return { kind: "empty" };
    console.warn(`[mail] accounts.load.failed (${failure.code})`);
    return { kind: "error" };
  }
}

export function useMailAccounts(loader: AccountsLoader = loadConnectedMailAccounts): { status: AccountsStatus; reload: () => void } {
  const [status, setStatus] = useState<AccountsStatus>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    void resolveAccountsStatus(loader).then((next) => {
      if (live) setStatus(next);
    });
    return () => {
      live = false;
    };
  }, [loader, attempt]);
  const reload = useCallback(() => {
    setStatus({ kind: "loading" });
    setAttempt((n) => n + 1);
  }, []);
  return { status, reload };
}
