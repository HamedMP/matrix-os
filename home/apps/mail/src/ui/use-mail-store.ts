/**
 * React bindings for the Mail store. The store is created inside an effect so
 * StrictMode's mount, unmount, mount cycle disposes one store and starts a
 * fresh one instead of reusing a disposed store.
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import { createMailStore, type MailAccountEntry, type MailState, type MailStore, type MailStoreOptions } from "../model";

export type StoreFactory = (options: MailStoreOptions) => MailStore;

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/** A started store for `entries`, or null until the first effect has run. */
export function useMailStore(entries: readonly MailAccountEntry[], factory: StoreFactory = createMailStore): MailStore | null {
  const [store, setStore] = useState<MailStore | null>(null);
  useEffect(() => {
    const next = factory({ accounts: [...entries] });
    setStore(next);
    next.start().catch((error: unknown) => console.warn(`[mail] store.start.failed (${errorName(error)})`));
    return () => {
      next.dispose().catch((error: unknown) => console.warn(`[mail] store.dispose.failed (${errorName(error)})`));
    };
  }, [entries, factory]);
  return store;
}

const noopSubscribe = () => () => undefined;

export function useMailState(store: MailStore): MailState;
export function useMailState(store: MailStore | null): MailState | null;
export function useMailState(store: MailStore | null): MailState | null {
  return useSyncExternalStore(store ? store.subscribe : noopSubscribe, store ? store.getSnapshot : () => null);
}
