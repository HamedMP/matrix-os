import { useSyncExternalStore } from "react";

interface Subscribable<T> {
  subscribe(listener: () => void): () => void;
  getState?(): T;
  getSnapshot?(): T;
  list?(): T;
}

const noopSubscribe = () => () => undefined;

/** Subscribes to one of the framework-free stores (agent, Mail store, proposals, bulk). */
export function useExternal<T>(source: Subscribable<T> | null | undefined, read: (source: Subscribable<T>) => T, fallback: T): T {
  return useSyncExternalStore(
    source ? source.subscribe : noopSubscribe,
    () => (source ? read(source) : fallback),
    () => (source ? read(source) : fallback),
  );
}
